import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeSchema, definitions, referenceAt } from "../src/language-service.ts";

test("locates schema-qualified declarations and composite foreign key targets", () => {
  const target = 'CREATE TABLE main."User Data" ("First" TEXT, second INTEGER);';
  const from =
    "CREATE TABLE child (a,b, FOREIGN KEY(a,b) REFERENCES [user data] (`first`, second) MATCH simple);";
  const parsed = analyzeSchema(from);
  for (const [token, declaration] of [
    ["[user data]", '"User Data"'],
    ["`first`", '"First"'],
    ["second", "second"],
  ] as const) {
    const ref = referenceAt(parsed, from.indexOf(token))!;
    const [span] = definitions(ref, analyzeSchema(target));
    assert.equal(target.slice(span!.start, span!.end), declaration);
  }
  assert.equal(referenceAt(parsed, from.indexOf("simple")), undefined);
});

test("reports the parser offset at EOF and outlines explicit view columns", () => {
  const sql = "CREATE TABLE t (";
  assert.equal(analyzeSchema(sql).diagnostics[0]?.start, sql.length);
  const [view] = analyzeSchema("CREATE VIEW v (a,b) AS SELECT x,y FROM t;").symbols;
  assert.deepEqual(
    view?.children.map((c) => c.name),
    ["a", "b"],
  );
});

test("resolves single-quoted foreign keys to their original declaration spans", () => {
  const source = "CREATE TABLE 'parent' ('it''s id' PRIMARY KEY);";
  const target = analyzeSchema(source);
  const sql = "CREATE TABLE child ('key', FOREIGN KEY ('key') REFERENCES 'parent' ('it''s id'));";
  const child = analyzeSchema(sql);
  assert.deepEqual(child.diagnostics, []);
  for (const token of ["'parent'", "'it''s id'"]) {
    const reference = referenceAt(child, sql.indexOf(token) + 1)!;
    const [span] = definitions(reference, target);
    assert.equal(source.slice(span!.start, span!.end), token);
  }
});

test("outlines contextual column names and resolves contextual foreign keys", () => {
  const source = "CREATE TABLE Plan (Generated PRIMARY KEY); CREATE VIEW v (Window) AS SELECT 1;";
  const target = analyzeSchema(source);
  assert.deepEqual(
    target.symbols.map((symbol) => symbol.children[0]?.name),
    ["Generated", "Window"],
  );
  const sql = "CREATE TABLE child (x REFERENCES plan(generated));";
  const child = analyzeSchema(sql);
  for (const name of ["Plan", "Generated"]) {
    const ref = referenceAt(child, sql.indexOf(name.toLowerCase()))!;
    const [span] = definitions(ref, target);
    assert.equal(source.slice(span!.start, span!.end), name);
  }
});
