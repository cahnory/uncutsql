import {
  type Codec,
  alternatives,
  document,
  followedBy,
  located,
  optional,
  prefixed,
  struct,
  transform,
} from "@uncutsql/codec";
import { flag } from "../operators/flag.ts";
import { keyword } from "../operators/keyword.ts";
import { lexeme } from "../operators/lexeme.ts";
import { terminator } from "../operators/terminator.ts";
import { trivia } from "../operators/trivia.ts";
import { tableReference } from "./table-reference.ts";
import { tableDefinition, type TableDefinition } from "./table-definition.ts";
import { tableOptions, type TableOption } from "./table-options.ts";

const definition = struct(
  {
    temporary: flag(alternatives(keyword("TEMPORARY"), keyword("TEMP"))),
    tableKeyword: keyword("TABLE"),
    ifNotExists: flag(
      prefixed(keyword("IF"), prefixed(keyword("NOT"), keyword("EXISTS"), " "), " "),
    ),
    reference: tableReference,
    definition: tableDefinition,
    options: optional(tableOptions),
  },
  " ",
);

export interface CreateTable extends TableDefinition {
  readonly _tag: "CreateTable";
  readonly temporary: boolean;
  readonly ifNotExists: boolean;
  readonly name: string;
  readonly schema?: string;
  readonly options?: readonly TableOption[];
}

export const createTableGrammar: Codec<CreateTable> = lexeme(
  located(
    "CreateTable",
    followedBy(
      prefixed(
        keyword("CREATE"),
        transform(definition, {
          decode: ({ tableKeyword: _, reference, definition, options, ...value }): CreateTable => ({
            _tag: "CreateTable",
            ...value,
            ...definition,
            ...reference,
            ...(options === undefined ? {} : { options }),
          }),
          encode: ({
            _tag: _,
            name,
            schema,
            columns,
            tableConstraints,
            options,
            ...value
          }: CreateTable) => ({
            ...value,
            tableKeyword: undefined,
            reference: { name, ...(schema === undefined ? {} : { schema }) },
            definition: { columns, tableConstraints },
            options,
          }),
        }),
        " ",
      ),
      terminator,
    ),
  ),
);

export const createTable = document(createTableGrammar, trivia);
