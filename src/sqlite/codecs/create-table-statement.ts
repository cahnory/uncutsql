import {
  type Codec,
  alternatives,
  document,
  followedBy,
  located,
  prefixed,
  struct,
  transform,
} from "../../codec/index.ts";
import { flag } from "../operators/flag.ts";
import { keyword } from "../operators/keyword.ts";
import { lexeme } from "../operators/lexeme.ts";
import { terminator } from "../operators/terminator.ts";
import { trivia } from "../operators/trivia.ts";
import { identifier } from "./identifier.ts";
import { tableDefinition, type TableDefinition } from "./table-definition.ts";

const definition = struct(
  {
    temporary: flag(alternatives(keyword("TEMPORARY"), keyword("TEMP"))),
    tableKeyword: keyword("TABLE"),
    ifNotExists: flag(
      prefixed(keyword("IF"), prefixed(keyword("NOT"), keyword("EXISTS"), " "), " "),
    ),
    name: identifier,
    definition: tableDefinition,
  },
  " ",
);

export interface CreateTable extends TableDefinition {
  readonly _tag: "CreateTable";
  readonly temporary: boolean;
  readonly ifNotExists: boolean;
  readonly name: string;
}

export const createTableGrammar: Codec<CreateTable> = lexeme(
  located(
    "CreateTable",
    followedBy(
      prefixed(
        keyword("CREATE"),
        transform(definition, {
          decode: ({ tableKeyword: _, definition, ...value }): CreateTable => ({
            _tag: "CreateTable",
            ...value,
            ...definition,
          }),
          encode: ({ _tag: _, columns, tableConstraints, ...value }: CreateTable) => ({
            ...value,
            tableKeyword: undefined,
            definition: { columns, tableConstraints },
          }),
        }),
        " ",
      ),
      terminator,
    ),
  ),
);

export const createTable = document(createTableGrammar, trivia);
