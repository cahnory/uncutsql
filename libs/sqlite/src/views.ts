import { Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import {
  schemaValueEqual,
  tableKey,
  type DatabaseSchema,
  type DatabaseMigration,
} from "@uncutsql/core";
import { createView, type CreateView } from "./codecs/create-view.ts";
import { foldIdentifier, tableIdentity, tableKey as sqliteKey } from "./schema-identity.ts";
import { semanticValue, syntaxValue } from "./schema-value.ts";

export const viewsFromDatabaseSchema = (database: DatabaseSchema) =>
  Effect.gen(function* () {
    const names = new Set(
      database.tables.flatMap((table) => [
        tableKey(table.identity),
        ...(table.indexes ?? []).map((index) => tableKey({ ...table.identity, name: index.key })),
      ]),
    );
    return yield* Effect.forEach(database.views ?? [], (view) =>
      Effect.gen(function* () {
        const { identity } = view;
        const key = tableKey(identity);
        if (
          names.has(key) ||
          identity.catalog === undefined ||
          foldIdentifier(identity.catalog) !== identity.catalog ||
          identity.schema !== undefined ||
          foldIdentifier(view.name) !== identity.name ||
          /^sqlite_/i.test(view.name)
        )
          return yield* Effect.fail(
            new EncodeError({ message: `Invalid or conflicting SQLite view identity ${key}` }),
          );
        names.add(key);
        const ast: CreateView = {
          _tag: "CreateView",
          temporary: false,
          ifNotExists: false,
          schema: identity.catalog,
          name: view.name,
          ...(view.columns ? { columns: view.columns } : {}),
          query: syntaxValue(view.query) as CreateView["query"],
        };
        const sql = yield* createView
          .encode(ast)
          .pipe(
            Effect.catchDefect(() =>
              Effect.fail(new EncodeError({ message: "Invalid SQLite view definition" })),
            ),
          );
        const parsed = yield* createView
          .decode(sql)
          .pipe(Effect.mapError((error) => new EncodeError({ message: error.message })));
        if (!schemaValueEqual(view.query, semanticValue(parsed.query)))
          return yield* Effect.fail(
            new EncodeError({ message: "Invalid SQLite view query in snapshot" }),
          );
        return parsed;
      }),
    );
  });

/** Suspend views during table DDL while applying only the requested logical changes. */
export const planViewOperations = (
  migration: DatabaseMigration,
  before: readonly CreateView[],
  after: readonly CreateView[],
  affectedSchemas: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const byKey = (views: readonly CreateView[]) =>
      new Map(views.map((view) => [sqliteKey(tableIdentity(view)), view]));
    const retained = byKey(before);
    const targets = byKey(after);
    const drops = new Map<string, CreateView>();
    const creates = new Map<string, CreateView>();
    for (const [key, view] of retained) {
      if (affectedSchemas.has(tableIdentity(view).schema)) {
        drops.set(key, view);
        creates.set(key, view);
      }
    }
    for (const procedure of migration.procedures) {
      if (!("view" in procedure) && procedure._tag !== "ReplaceView") continue;
      const view = "view" in procedure ? procedure.view : procedure.before;
      const key = sqliteKey({ schema: view.identity.catalog ?? "", name: view.identity.name });
      if (procedure._tag !== "CreateView") {
        const old = retained.get(key);
        if (!old)
          return yield* Effect.fail(
            new EncodeError({ message: "Missing source view in migration context" }),
          );
        drops.set(key, old);
        creates.delete(key);
        retained.delete(key);
      }
      if (procedure._tag !== "DropView") {
        const target = targets.get(key);
        if (!target || retained.has(key))
          return yield* Effect.fail(
            new EncodeError({ message: "Invalid target view in migration context" }),
          );
        creates.set(key, target);
        retained.set(key, target);
      }
    }
    return {
      drops: Array.from(drops.values(), (view) => ({
        _tag: "DropView" as const,
        table: tableIdentity(view),
      })),
      creates: Array.from(creates.values(), (definition) => ({
        _tag: "CreateView" as const,
        table: tableIdentity(definition),
        definition,
      })),
      retained: retained.values(),
    };
  });
