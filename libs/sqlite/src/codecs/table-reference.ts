import { type Codec, located, optional, prefixed, transform, tuple } from "@uncutsql/codec";
import { lexeme } from "../operators/lexeme.ts";
import { punctuation } from "../operators/punctuation.ts";
import { contextualNameKeywords } from "../lexer/keywords.ts";
import { nameWithKeywords } from "./identifier.ts";

export interface TableReference {
  readonly name: string;
  readonly schema?: string;
}

const relationName = nameWithKeywords(contextualNameKeywords);

/** A dot inside a quoted identifier belongs to the name, not to its qualifier. */
export const tableReference: Codec<TableReference> = lexeme(
  located(
    "TableReference",
    transform(tuple([relationName, optional(prefixed(punctuation("."), relationName))]), {
      decode: ([first, second]): TableReference =>
        second === undefined ? { name: first } : { schema: first, name: second },
      encode: ({ name, schema }: TableReference) =>
        schema === undefined ? ([name, undefined] as const) : ([schema, name] as const),
    }),
  ),
);
