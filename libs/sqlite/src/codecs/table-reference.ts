import { type Codec, located, optional, prefixed, transform, tuple } from "@uncutsql/codec";
import { lexeme } from "../operators/lexeme.ts";
import { punctuation } from "../operators/punctuation.ts";
import { nameIdentifier } from "./identifier.ts";

export interface TableReference {
  readonly name: string;
  readonly schema?: string;
}

/** A dot inside a quoted identifier belongs to the name, not to its qualifier. */
export const tableReference: Codec<TableReference> = lexeme(
  located(
    "TableReference",
    transform(tuple([nameIdentifier, optional(prefixed(punctuation("."), nameIdentifier))]), {
      decode: ([first, second]): TableReference =>
        second === undefined ? { name: first } : { schema: first, name: second },
      encode: ({ name, schema }: TableReference) =>
        schema === undefined ? ([name, undefined] as const) : ([schema, name] as const),
    }),
  ),
);
