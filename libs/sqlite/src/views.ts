import { Effect } from "effect";

import { EncodeError } from "@uncutsql/codec";
import { schemaValueEqual, tableKey } from "@uncutsql/core";
import type { DatabaseMigration, DatabaseSchema } from "@uncutsql/core";

import { createView } from "./codecs/create-view.ts";
import type { CreateView } from "./codecs/create-view.ts";
import { planDeclarations } from "./plan-declarations.ts";
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
        ) {
          return yield* Effect.fail(
            new EncodeError({ message: `Invalid or conflicting SQLite view identity ${key}` }),
          );
        }
        names.add(key);
        const ast: CreateView = {
          _tag: "CreateView",
          ifNotExists: false,
          name: view.name,
          schema: identity.catalog,
          temporary: false,
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
        if (!schemaValueEqual(view.query, semanticValue(parsed.query))) {
          return yield* Effect.fail(
            new EncodeError({ message: "Invalid SQLite view query in snapshot" }),
          );
        }
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
      if (p._tag === "ReplaceView") {
        return [{ create: true, drop: true, identity: p.before.identity }];
      }
      if ("view" in p) {
        return [
          {
            create: p._tag === "CreateView",
            drop: p._tag === "DropView",
            identity: p.view.identity,
          },
        ];
      }
      return [];
    });
    const steps = yield* planDeclarations(before, after, changes, (view) =>
      affectedSchemas.has(tableIdentity(view).schema),
    );
    return {
      creates: steps.creates.map((definition) => ({
        _tag: "CreateView" as const,
        definition,
        table: tableIdentity(definition),
      })),
      drops: steps.drops.map((view) => ({ _tag: "DropView" as const, table: tableIdentity(view) })),
      retained: steps.retained,
    };
  });
