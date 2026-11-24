import { Data, Effect } from "effect";
import { decodeDatabaseSchema } from "./decode.ts";
import {
  compareTable,
  diffDatabases,
  type DatabaseDiff,
  type DropGuard,
  type TableAlteration,
  type TableChange,
} from "./diff.ts";
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
  /** Added table names or column keys, not guesses: no candidate is selected automatically. */
  readonly candidates: readonly string[];
  readonly resolution:
    | { readonly action: "pending" }
    | { readonly action: "drop_if_empty" | "drop" }
    | { readonly action: "rename"; readonly target: string };
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
const renamedColumnId = (source: TableIdentity, target: TableIdentity, column: string) =>
  JSON.stringify([tableKey(source), tableKey(target), column]);
const columnId = (change: Extract<TableChange, { before: unknown }>, column: string) =>
  change._tag === "TableRenamed"
    ? renamedColumnId(change.before.identity, change.after.identity, column)
    : idFor(change.table, column);
const questions = (diff: DatabaseDiff): readonly MigrationDecision[] =>
  diff.changes.flatMap<MigrationDecision>((change) => {
    if (change._tag === "TableRemoved") {
      const candidates = diff.changes.flatMap((item) =>
        item._tag === "TableAdded" &&
        item.table.catalog === change.table.catalog &&
        item.table.schema === change.table.schema
          ? [item.table.name]
          : [],
      );
      return [
        {
          id: idFor(change.table),
          table: change.table,
          question: candidates.length
            ? `Drop table ${tableKey(change.table)}, or rename it to an added table?`
            : `Drop table ${tableKey(change.table)} and its data?`,
          candidates,
          resolution: { action: "pending" },
        },
      ];
    }
    if (change._tag === "TableAdded") return [];
    const candidates = change.changes
      .filter((item) => item._tag === "ColumnAdded")
      .map((item) => item.column.key);
    return change.changes
      .filter((item) => item._tag === "ColumnRemoved")
      .map((item) => ({
        id: columnId(change, item.column.key),
        table: change.table,
        column: item.column.key,
        question: candidates.length
          ? `Drop column ${JSON.stringify(item.column.name)} in ${tableKey(change.table)}, or rename it to an added column?`
          : `Drop column ${JSON.stringify(item.column.name)} in ${tableKey(change.table)}?`,
        candidates,
        resolution: { action: "pending" },
      }));
  });
export const prepareMigrationDecisions = (before: DatabaseSchema, after: DatabaseSchema) =>
  Effect.map(diffDatabases(before, after), (diff) => ({
    version: 1 as const,
    before,
    after,
    decisions: questions(diff),
  }));

const readAnswers = (
  pending: MigrationDecisions,
  inputs: readonly unknown[],
  allowPending: boolean,
) =>
  Effect.gen(function* () {
    const fail = (message: string) => Effect.fail(new MigrationDecisionError({ message, pending }));
    const expected = new Map(pending.decisions.map((item) => [item.id, item]));
    const answers = new Map<string, MigrationDecision>();
    const targets = new Set<string>();
    for (const input of inputs) {
      if (!record(input) || typeof input.id !== "string")
        return yield* fail("Each decision needs its original id.");
      const question = expected.get(input.id);
      if (!question || answers.has(input.id))
        return yield* fail(`Unknown or duplicate decision: ${input.id}`);
      if (!equal(input.table, question.table) || input.column !== question.column)
        return yield* fail(`Decision identity changed: ${input.id}`);
      const resolution = input.resolution;
      if (
        allowPending &&
        record(resolution) &&
        resolution.action === "pending" &&
        Object.keys(resolution).length === 1
      ) {
        answers.set(input.id, question);
        continue;
      }
      if (!record(resolution) || resolution.action === "pending")
        return yield* fail(`Unresolved decision: ${question.question}`);
      if (
        (resolution.action === "drop" || resolution.action === "drop_if_empty") &&
        Object.keys(resolution).length === 1
      ) {
        answers.set(input.id, { ...question, resolution: { action: resolution.action } });
      } else if (
        resolution.action === "rename" &&
        Object.keys(resolution).length === 2 &&
        typeof resolution.target === "string" &&
        question.candidates.includes(resolution.target)
      ) {
        const target =
          question.column === undefined
            ? idFor({ ...question.table, name: resolution.target })
            : idFor(question.table, resolution.target);
        if (targets.has(target))
          return yield* fail(
            `Multiple source ${question.column === undefined ? "tables" : "columns"} map to ${resolution.target}.`,
          );
        targets.add(target);
        answers.set(input.id, {
          ...question,
          resolution: { action: "rename", target: resolution.target },
        });
      } else return yield* fail(`Invalid resolution for ${question.question}`);
    }
    if (answers.size !== expected.size)
      return yield* fail(
        "Missing migration decisions: every removal requires an explicit resolution.",
      );
    return answers;
  });

// Pair tables first. Only then can their removed columns become review questions.
const expandRenames = (diff: DatabaseDiff, answers: ReadonlyMap<string, MigrationDecision>) => {
  const additions = new Map(
    diff.changes
      .filter((item) => item._tag === "TableAdded")
      .map((item) => [tableKey(item.table), item]),
  );
  const renames: TableChange[] = [];
  for (const source of diff.changes) {
    if (source._tag !== "TableRemoved") continue;
    const choice = answers.get(idFor(source.table))?.resolution;
    if (choice?.action !== "rename") continue;
    const key = tableKey({ ...source.table, name: choice.target });
    const target = additions.get(key)!;
    additions.delete(key);
    renames.push({
      _tag: "TableRenamed",
      table: source.table,
      before: source.definition,
      after: target.definition,
      changes: compareTable(source.definition, target.definition),
    });
  }
  const changes = diff.changes.filter((item) => {
    if (item._tag === "TableAdded") return additions.has(tableKey(item.table));
    return (
      item._tag !== "TableRemoved" || answers.get(idFor(item.table))?.resolution.action !== "rename"
    );
  });
  return { diff: { changes: [...changes, ...renames] }, nested: questions({ changes: renames }) };
};

const reviewAnswers = (
  pending: MigrationDecisions,
  diff: DatabaseDiff,
  inputs: readonly unknown[],
  merging: boolean,
) =>
  Effect.gen(function* () {
    const rootIds = new Set(pending.decisions.map((item) => item.id));
    const roots = inputs.filter(
      (input) => record(input) && typeof input.id === "string" && rootIds.has(input.id),
    );
    const rootAnswers = yield* readAnswers(pending, roots, merging);
    const expanded = expandRenames(diff, rootAnswers);
    const review = { ...pending, decisions: [...rootAnswers.values(), ...expanded.nested] };
    const expected = new Set(review.decisions.map((item) => item.id));
    const current = inputs.filter((input) => {
      if (
        !merging ||
        !record(input) ||
        typeof input.column !== "string" ||
        typeof input.id !== "string" ||
        expected.has(input.id)
      )
        return true;
      // Drop questions issued for an earlier pairing when a reviewer edits the parent.
      const column = input.column;
      return !pending.decisions.some(
        (parent) =>
          parent.column === undefined &&
          equal(parent.table, input.table) &&
          parent.candidates.some(
            (name) => input.id === renamedColumnId(parent.table, { ...parent.table, name }, column),
          ),
      );
    });
    const ids = new Set(current.flatMap((input) => (record(input) ? [input.id] : [])));
    const missing = expanded.nested.filter((item) => !ids.has(item.id));
    if (!merging && missing.length)
      return yield* Effect.fail(
        new MigrationDecisionError({
          message: "Table rename requires column decisions. Run --merge-decisions to review them.",
          pending: review,
        }),
      );
    const answers = yield* readAnswers(review, [...current, ...missing], merging);
    return { diff: expanded.diff, answers };
  });

/** Refresh the questions and snapshots, carrying forward applicable reviewed choices. */
export const mergeMigrationDecisions = (fresh: MigrationDecisions, previous: unknown) =>
  Effect.gen(function* () {
    if (!record(previous) || previous.version !== 1 || !Array.isArray(previous.decisions))
      return yield* Effect.fail(
        new MigrationDecisionError({
          message: "Expected a version 1 migration decision document.",
          pending: fresh,
        }),
      );
    const before = yield* decodeDatabaseSchema(previous.before);
    const after = yield* decodeDatabaseSchema(previous.after);
    const originalDiff = yield* diffDatabases(before, after);
    const original = { version: 1 as const, before, after, decisions: questions(originalDiff) };
    const { answers } = yield* reviewAnswers(original, originalDiff, previous.decisions, true);
    const carry = (question: MigrationDecision) => {
      const resolution = answers.get(question.id)?.resolution;
      if (
        !resolution ||
        (resolution.action === "rename" && !question.candidates.includes(resolution.target))
      )
        return question;
      return { ...question, resolution };
    };
    const freshDiff = yield* diffDatabases(fresh.before, fresh.after);
    const roots = questions(freshDiff).map(carry);
    const expanded = expandRenames(freshDiff, new Map(roots.map((item) => [item.id, item])));
    return { ...fresh, decisions: [...roots, ...expanded.nested.map(carry)] };
  });

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
          "Unresolved migration decisions. Prepare a decision file and resolve each removal before planning.",
        );
      return { diff, decisions: pending };
    }
    if (!record(supplied) || supplied.version !== 1 || !Array.isArray(supplied.decisions))
      return yield* fail("Expected a version 1 migration decision document.");
    if (!equal(supplied.before, before) || !equal(supplied.after, after))
      return yield* fail(
        "Stale migration decisions: source or target schema changed. Prepare a new decision file.",
      );
    const reviewed = yield* reviewAnswers(pending, diff, supplied.decisions, false);
    const answers = reviewed.answers;
    const dropGuards: DropGuard[] = [];
    const changes = reviewed.diff.changes.map((change) => {
      if (change._tag === "TableRemoved" || change._tag === "TableAdded") {
        if (
          change._tag === "TableRemoved" &&
          answers.get(idFor(change.table))?.resolution.action === "drop_if_empty"
        )
          dropGuards.push({ table: change.table });
        return change;
      }
      const renamedTargets = new Set<string>();
      const changes: TableAlteration[] = [];
      for (const item of change.changes) {
        if (item._tag !== "ColumnRemoved") continue;
        const answer = answers.get(columnId(change, item.column.key))!;
        if (answer.resolution.action === "drop_if_empty")
          dropGuards.push({ table: change.table, column: item.column.name });
        if (answer.resolution.action !== "rename") continue;
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
                answers.get(columnId(change, item.column.key))?.resolution.action === "rename"
              ),
          ),
        ],
      };
    });
    const resolved: DatabaseDiff = { changes, ...(dropGuards.length ? { dropGuards } : {}) };
    return { diff: resolved, decisions: { ...pending, decisions: [...answers.values()] } };
  });
