import { Effect } from "effect";

import { EncodeError } from "@uncutsql/codec";
import type { DatabaseIndex, DatabaseSchema } from "@uncutsql/core";

import { createIndex } from "./codecs/create-index.ts";
import type { CreateIndex } from "./codecs/create-index.ts";
import { foldIdentifier } from "./schema-identity.ts";
import { semanticValue, syntaxValue } from "./schema-value.ts";

export const indexModel = (index: CreateIndex): DatabaseIndex => ({
  key: foldIdentifier(index.name),
  name: index.name,
  terms: index.terms.map((term) =>
    semanticValue({
      expression: term.expression,
      ...(term.direction === "DESC" ? { direction: "DESC" } : {}),
    }),
  ),
  unique: index.unique,
  where: index.where === undefined ? null : semanticValue(index.where),
});
export const indexesFromDatabaseSchema = (
  database: DatabaseSchema,
): Effect.Effect<readonly CreateIndex[], EncodeError> =>
  Effect.gen(function* () {
    const results: CreateIndex[] = [];
    const names = new Set(
      database.tables.map((table) => JSON.stringify([table.identity.catalog, table.identity.name])),
    );
    for (const table of database.tables) {
      for (const index of table.indexes ?? []) {
        if (
          index.key !== foldIdentifier(index.name) ||
          /^sqlite_/i.test(index.name) ||
          table.identity.catalog === undefined ||
          table.identity.schema !== undefined
        ) {
          return yield* Effect.fail(new EncodeError({ message: "Invalid SQLite index identity" }));
        }
        const key = JSON.stringify([table.identity.catalog, index.key]);
        if (names.has(key)) {
          return yield* Effect.fail(
            new EncodeError({ message: "Duplicate SQLite table/index name" }),
          );
        }
        names.add(key);
        const ast = {
          _tag: "CreateIndex",
          ifNotExists: false,
          name: index.name,
          schema: table.identity.catalog,
          table: table.name,
          terms: index.terms.map(syntaxValue),
          unique: index.unique,
          ...(index.where === null ? {} : { where: syntaxValue(index.where) }),
        } as CreateIndex;
        const sql = yield* createIndex
          .encode(ast)
          .pipe(
            Effect.catchDefect(() =>
              Effect.fail(new EncodeError({ message: "Invalid SQLite index definition" })),
            ),
          );
        results.push(
          yield* createIndex
            .decode(sql)
            .pipe(Effect.mapError((error) => new EncodeError({ message: error.message }))),
        );
      }
    }
    return results;
  });
