import { Data, Effect } from "effect";
import { diffDatabases, type DatabaseDiff, type TableAlteration } from "./diff.ts";
import {
  schemaValueEqual,
  tableKey,
  type DatabaseSchema,
  type TableIdentity,
  type SchemaValue,
} from "./model.ts";

export interface MigrationDecision {
  readonly id: string;
  readonly table: TableIdentity;
  readonly column?: string;
  readonly question: string;
  /** Added column keys, not guesses: no candidate is selected automatically. */
  readonly candidates: readonly string[];
  readonly resolution:
    | null
    | { readonly _tag: "Drop" }
    | { readonly _tag: "Rename"; readonly target: string };
}
export interface MigrationDecisions {
  readonly version: 1;
  readonly before: DatabaseSchema;
  readonly after: DatabaseSchema;
  readonly decisions: readonly MigrationDecision[];
}
export class MigrationDecisionError extends Data.TaggedError("MigrationDecisionError")<{
  readonly message: string;
  readonly pending: MigrationDecisions;
}> {}
const equal = (a: unknown, b: unknown) => schemaValueEqual(a as SchemaValue, b as SchemaValue);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const idFor = (table: TableIdentity, column?: string) =>
  JSON.stringify([tableKey(table), column ?? null]);
const questions = (diff: DatabaseDiff): readonly MigrationDecision[] =>
  diff.changes.flatMap<MigrationDecision>((change) => {
    if (change._tag === "TableRemoved")
      return [
        {
          id: idFor(change.table),
          table: change.table,
          question: `Drop table ${tableKey(change.table)} and its data?`,
          candidates: [],
          resolution: null,
        },
      ];
    if (change._tag !== "TableChanged") return [];
    const candidates = change.changes
      .filter((item) => item._tag === "ColumnAdded")
      .map((item) => item.column.key);
    return change.changes
      .filter((item) => item._tag === "ColumnRemoved")
      .map((item) => ({
        id: idFor(change.table, item.column.key),
        table: change.table,
        column: item.column.key,
        question: `Drop column ${JSON.stringify(item.column.name)} in ${tableKey(change.table)}, or rename it to an added column?`,
        candidates,
        resolution: null,
      }));
  });
export const prepareMigrationDecisions = (before: DatabaseSchema, after: DatabaseSchema) =>
  Effect.map(diffDatabases(before, after), (diff) => ({
    version: 1 as const,
    before,
    after,
    decisions: questions(diff),
  }));

/** Validate untrusted JSON and resolve intent against fresh comparison results. */
export const resolveMigrationDecisions = (
  before: DatabaseSchema,
  after: DatabaseSchema,
  supplied?: unknown,
) =>
  Effect.gen(function* () {
    const diff = yield* diffDatabases(before, after);
    const pending: MigrationDecisions = { version: 1, before, after, decisions: questions(diff) };
    const fail = (message: string) => Effect.fail(new MigrationDecisionError({ message, pending }));
    if (supplied === undefined) {
      if (pending.decisions.length)
        return yield* fail(
          "Unresolved migration decisions. Prepare a decision file and choose Drop or Rename for each removal before planning.",
        );
      return { diff, decisions: pending };
    }
    if (!record(supplied) || supplied.version !== 1 || !Array.isArray(supplied.decisions))
      return yield* fail("Expected a version 1 migration decision document.");
    if (!equal(supplied.before, before) || !equal(supplied.after, after))
      return yield* fail(
        "Stale migration decisions: source or target schema changed. Prepare a new decision file.",
      );
    const expected = new Map(pending.decisions.map((item) => [item.id, item]));
    const answers = new Map<string, MigrationDecision>();
    const targets = new Set<string>();
    for (const input of supplied.decisions) {
      if (!record(input) || typeof input.id !== "string")
        return yield* fail("Each decision needs its original id.");
      const question = expected.get(input.id);
      if (!question || answers.has(input.id))
        return yield* fail(`Unknown or duplicate decision: ${input.id}`);
      if (!equal(input.table, question.table) || input.column !== question.column)
        return yield* fail(`Decision identity changed: ${input.id}`);
      const resolution = input.resolution;
      if (!record(resolution)) return yield* fail(`Unresolved decision: ${question.question}`);
      if (resolution._tag === "Drop" && Object.keys(resolution).length === 1) {
        answers.set(input.id, { ...question, resolution: { _tag: "Drop" } });
      } else if (
        resolution._tag === "Rename" &&
        Object.keys(resolution).length === 2 &&
        typeof resolution.target === "string" &&
        question.column !== undefined &&
        question.candidates.includes(resolution.target)
      ) {
        const target = idFor(question.table, resolution.target);
        if (targets.has(target))
          return yield* fail(`Multiple source columns map to ${resolution.target}.`);
        targets.add(target);
        answers.set(input.id, {
          ...question,
          resolution: { _tag: "Rename", target: resolution.target },
        });
      } else return yield* fail(`Invalid resolution for ${question.question}`);
    }
    if (answers.size !== expected.size)
      return yield* fail(
        "Missing migration decisions: every removal requires an explicit resolution.",
      );
    const resolved: DatabaseDiff = {
      changes: diff.changes.map((change) => {
        if (change._tag !== "TableChanged") return change;
        const renamedTargets = new Set<string>();
        const changes: TableAlteration[] = [];
        for (const item of change.changes) {
          if (item._tag !== "ColumnRemoved") continue;
          const answer = answers.get(idFor(change.table, item.column.key))!;
          if (answer.resolution?._tag !== "Rename") continue;
          const targetKey = answer.resolution.target;
          const afterColumn = change.after.columns.find((column) => column.key === targetKey)!;
          renamedTargets.add(afterColumn.key);
          const fields: ("dataType" | "constraints")[] = [];
          if (!equal(item.column.dataType, afterColumn.dataType)) fields.push("dataType");
          if (!equal(item.column.constraints, afterColumn.constraints)) fields.push("constraints");
          changes.push({ _tag: "ColumnRenamed", before: item.column, after: afterColumn, fields });
        }
        return {
          ...change,
          changes: [
            ...changes,
            ...change.changes.filter(
              (item) =>
                !(item._tag === "ColumnAdded" && renamedTargets.has(item.column.key)) &&
                !(
                  item._tag === "ColumnRemoved" &&
                  answers.get(idFor(change.table, item.column.key))?.resolution?._tag === "Rename"
                ),
            ),
          ],
        };
      }),
    };
    return { diff: resolved, decisions: { ...pending, decisions: [...answers.values()] } };
  });
