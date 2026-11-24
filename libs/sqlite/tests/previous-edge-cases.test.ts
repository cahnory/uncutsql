import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { Effect, Result } from "effect";

import { document, ParseError } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { columnConstraint } from "../src/codecs/column-constraint.ts";
import { createTableGrammar } from "../src/codecs/create-table-statement.ts";
import { tableOptions } from "../src/codecs/table-options.ts";
import { tableReference } from "../src/codecs/table-reference.ts";
import { columnType } from "../src/codecs/type-name.ts";
import { trivia } from "../src/operators/trivia.ts";

// Preserve the old filenames, including .skip, but run every imported case.
// Explicit overrides document ambiguously classified edges and newly supported syntax.
const overrides: Readonly<Record<string, boolean>> = {
  "column-constraint/edge/04_collate_keyword_name_unquoted.sql": false,
  "create-table-statement/edge/02_keyword_as_identifier_unquoted.sql": false,
  "table-options/invalid/03_strict_twice.skip.sql": true,
  "table-reference/edge/01_table_is_keyword_unquoted.sql": false,
  "table-reference/edge/02_schema_is_keyword_unquoted.sql": false,
  // SQLite bracket quoting ends at the first ]; doubled brackets do not escape it.
  "table-reference/valid/17_table_with_escaped_bracket.sql": false,
  "type-name/edge/02_keyword_like.skip.sql": false,
};

const fixtureTests = <A>(group: string, grammar: Codec<A>) => {
  const root = new URL(`./fixtures/previous/${group}/`, import.meta.url);
  const codec = document(grammar, trivia);
  for (const category of readdirSync(root)) {
    for (const name of readdirSync(new URL(`${category}/`, root))) {
      const key = `${group}/${category}/${name}`;
      const expected = overrides[key] ?? category !== "invalid";
      test(`previous fixture ${key}: ${expected ? "accept" : "reject"}`, () => {
        const source = readFileSync(new URL(`${category}/${name}`, root), "utf8");
        const result = Effect.runSync(Effect.result(codec.decode(source)));
        if (!expected) {
          assert.ok(Result.isFailure(result), key);
          assert.ok(result.failure instanceof ParseError);
          return;
        }
        assert.ok(
          Result.isSuccess(result),
          Result.isFailure(result) ? result.failure.message : key,
        );
        const sql = Effect.runSync(codec.encode(result.success));
        assert.deepEqual(Effect.runSync(codec.decode(sql)), result.success);
      });
    }
  }
};

fixtureTests("column-constraint", columnConstraint);
fixtureTests("type-name", columnType);
fixtureTests("table-options", tableOptions);
fixtureTests("create-table-statement", createTableGrammar);

fixtureTests("table-reference", tableReference);
