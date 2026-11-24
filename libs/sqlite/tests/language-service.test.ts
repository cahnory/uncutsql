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
