import { Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import {
  schemaValueEqual,
  tableKey,
  type DatabaseSchema,
  type DatabaseMigration,
} from "@uncutsql/core";
import { planDeclarations } from "./plan-declarations.ts";
import { createView, type CreateView } from "./codecs/create-view.ts";
import { foldIdentifier, tableIdentity } from "./schema-identity.ts";
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

export const planViewOperations = (
  migration: DatabaseMigration,
  before: readonly CreateView[],
  after: readonly CreateView[],
  affectedSchemas: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const changes = migration.procedures.flatMap((p) => {
      if (p._tag === "ReplaceView")
        return [{ identity: p.before.identity, drop: true, create: true }];
      if ("view" in p)
        return [
          {
            identity: p.view.identity,
            drop: p._tag === "DropView",
            create: p._tag === "CreateView",
          },
        ];
      return [];
    });
    const steps = yield* planDeclarations(before, after, changes, (view) =>
      affectedSchemas.has(tableIdentity(view).schema),
    );
    return {
      drops: steps.drops.map((view) => ({ _tag: "DropView" as const, table: tableIdentity(view) })),
      creates: steps.creates.map((definition) => ({
        _tag: "CreateView" as const,
        table: tableIdentity(definition),
        definition,
      })),
      retained: steps.retained,
    };
  });
