import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Ajv } from "ajv";
import { Effect } from "effect";

import { prepareMigrationDecisions, resolveMigrationDecisions } from "@uncutsql/core";
import type { DatabaseSchema } from "@uncutsql/core";

import { resolveConfig } from "../src/config.ts";

const compile = (name: string) =>
  new Ajv({ strict: true }).compile(
    JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8")),
  );

test("config schema agrees with runtime on editor metadata and invalid options", async () => {
  const validate = compile("config");
  const cwd = mkdtempSync(join(tmpdir(), "uncutsql-schema-"));
  try {
    for (const [config, valid] of [
      [{}, true],
      [{ $schema: "./config.schema.json", dialect: "@uncutsql/sqlite", schema: "./db" }, true],
      [{ schema: "   " }, false],
      [{ $schema: 123 }, false],
      [{ schemas: "./db" }, false],
      [{ migrations: null }, false],
    ] as const) {
      assert.equal(validate(config), valid, JSON.stringify(validate.errors));
      writeFileSync(join(cwd, "uncutsql.config.json"), JSON.stringify(config));
      if (valid) {
        await Effect.runPromise(resolveConfig({}, cwd));
      } else {
        await assert.rejects(Effect.runPromise(resolveConfig({}, cwd)));
      }
    }
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("decisions schema validates generated snapshots and editable resolutions", () => {
  const validate = compile("decisions");
  const model = (key: string): DatabaseSchema => ({
    tables: [
      {
        columns: [
          { constraints: [], dataType: { args: [null, 1, true], name: "TEXT" }, key, name: key },
        ],
        constraints: [{ kind: "fixture", properties: { nested: { values: [false] } } }],
        identity: { name: "users" },
        indexes: [{ key: "idx", name: "idx", terms: [key], unique: false, where: null }],
        name: "users",
        options: {},
      },
    ],
    triggers: [
      {
        definition: { actions: [key] },
        identity: { name: "log" },
        name: "log",
        target: { name: "users" },
      },
    ],
  });
  const before = model("old");
  const after = model("new");
  const pending = Effect.runSync(prepareMigrationDecisions(before, after));
  assert.equal(validate(pending), true, JSON.stringify(validate.errors));
  for (const resolution of [
    { action: "drop_if_empty" },
    { action: "drop" },
    { action: "rename", target: "new" },
  ]) {
    const answered = {
      $schema: "./decisions.schema.json",
      ...pending,
      decisions: pending.decisions.map((item) => ({ ...item, resolution })),
    };
    assert.equal(validate(answered), true, JSON.stringify(validate.errors));
    Effect.runSync(resolveMigrationDecisions(before, after, answered));
  }
  for (const resolution of [
    { action: "rename" },
    { action: "drop", target: "new" },
    { action: "other" },
    null,
    {},
    { action: "pending", target: "new" },
    { action: "rename", target: 1 },
    { action: "drop", extra: true },
  ]) {
    assert.equal(
      validate({
        ...pending,
        decisions: pending.decisions.map((item) => ({ ...item, resolution })),
      }),
      false,
    );
  }
  assert.equal(validate({ ...pending, version: 2 }), false);
  assert.equal(validate({ ...pending, before: { tables: [{}] } }), false);
  const removed = Effect.runSync(prepareMigrationDecisions(before, { tables: [] }));
  assert.equal(validate(removed), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...removed,
      decisions: removed.decisions.map((item) => ({
        ...item,
        resolution: { action: "rename", target: "new" },
      })),
    }),
    false,
  );
});

test("action completion offers column choices before a target exists and offers table renames when targets exist", async () => {
  const { getLanguageService } = await import("vscode-json-languageservice");
  const { TextDocument } = await import("vscode-languageserver-textdocument");
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/decisions.schema.json", import.meta.url), "utf8"),
  );
  const service = getLanguageService({});
  service.configure({
    schemas: [
      { fileMatch: ["*.json"], schema, uri: "https://uncutsql.test/decisions.schema.json" },
    ],
  });
  const base = {
    after: { tables: [] },
    before: { tables: [] },
    decisions: [
      {
        candidates: ["new"],
        column: "old",
        id: "fixture",
        question: "Drop or rename?",
        resolution: { action: "pending" },
        table: { name: "t" },
      },
    ],
    version: 1,
  };
  for (const [column, candidates] of [
    ["old", ["new"]],
    ["old", []],
    [undefined, []],
    [undefined, ["new_table"]],
  ] as const) {
    for (const value of ['"|pending"', "|", '"|rename"']) {
      const source = JSON.stringify({
        ...base,
        decisions: base.decisions.map((item) => ({ ...item, candidates, column })),
      }).replace('"pending"', value);
      const offset = source.indexOf("|");
      const document = TextDocument.create(
        "file:///review.json",
        "json",
        1,
        source.replace("|", ""),
      );
      const completion = await service.doComplete(
        document,
        document.positionAt(offset),
        service.parseJSONDocument(document),
      );
      const labels = completion!.items.map((item) => item.label);
      for (const action of ["pending", "drop_if_empty", "drop"]) {
        assert.ok(labels.includes(JSON.stringify(action)), JSON.stringify(labels));
      }
      assert.equal(labels.includes('"rename"'), candidates.length > 0, JSON.stringify(labels));
    }
  }
});
