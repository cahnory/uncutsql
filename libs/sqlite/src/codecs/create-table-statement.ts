import { Effect } from "effect";
import {
  type Codec,
  commit,
  document,
  followedBy,
  located,
  make,
  optional,
  parseError,
  struct,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import { lexeme } from "../operators/lexeme.ts";
import { terminator } from "../operators/terminator.ts";
import { trivia } from "../operators/trivia.ts";
import { createTableHeader, type CreateTableHeader } from "./create-table-header.ts";
import { createTableAsDefinition, type CreateTableAs } from "./create-table-as.ts";
import { tableDefinition, type TableDefinition } from "./table-definition.ts";
import { tableOptions, type TableOption } from "./table-options.ts";

export interface CreateTable extends CreateTableHeader, TableDefinition {
  readonly _tag: "CreateTable";
  readonly options?: readonly TableOption[];
}
export type CreateTableStatement = CreateTable | CreateTableAs;

const definition = taggedUnion({
  CreateTable: transform(
    struct({ definition: tableDefinition, options: optional(tableOptions) }, " "),
    {
      decode: ({ definition, options }) => ({
        _tag: "CreateTable" as const,
        ...definition,
        ...(options === undefined ? {} : { options }),
      }),
      encode: (value) => ({
        definition: { columns: value.columns, tableConstraints: value.tableConstraints },
        options: value.options,
      }),
    },
  ),
  CreateTableAs: createTableAsDefinition,
});

/** Shared body; single-statement and schema-file APIs own their terminators. */
export const createTableStatementBodyGrammar: Codec<CreateTableStatement> = transform(
  struct({ header: createTableHeader, definition: commit(definition) }, " "),
  {
    decode: ({ header, definition }): CreateTableStatement => ({ ...header, ...definition }),
    encode: (value: CreateTableStatement) => ({ header: value, definition: value }),
  },
);

/** Retain the explicit-column API for schema models and migration rendering. */
export const createTableBodyGrammar: Codec<CreateTable> = make<CreateTable>({
  decode: (cursor) =>
    Effect.gen(function* () {
      const result = yield* createTableStatementBodyGrammar.decode(cursor);
      if (result.value._tag !== "CreateTable")
        return yield* Effect.fail(
          parseError(
            cursor,
            "an explicit column definition (use createTableStatement for AS queries)",
            true,
          ),
        );
      return { ...result, value: result.value };
    }),
  encode: createTableStatementBodyGrammar.encode,
});
export const createTableGrammar: Codec<CreateTable> = lexeme(
  located("CreateTable", followedBy(createTableBodyGrammar, terminator)),
);
export const createTable = document(createTableGrammar, trivia);
export const createTableStatementGrammar = lexeme(
  located("CreateTableStatement", followedBy(createTableStatementBodyGrammar, terminator)),
);
export const createTableStatement = document(createTableStatementGrammar, trivia);
