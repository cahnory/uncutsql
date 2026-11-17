import { Effect } from "effect";
import {
  type Codec,
  alternatives,
  located,
  make,
  optional,
  prefixed,
  read,
  transform,
  tuple,
} from "@uncutsql/codec";
import { lexeme } from "../operators/lexeme.ts";
import { keyword } from "../operators/keyword.ts";
import { punctuation } from "../operators/punctuation.ts";
import { identifier } from "./identifier.ts";

export interface TableReference {
  readonly name: string;
  readonly schema?: string;
}

// TEMP is a keyword but also SQLite's built-in schema name. Permit it only
// before a dot, retaining its spelling like any other identifier.
const tempSchema = lexeme(
  make<string>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* keyword("TEMP").decode(cursor);
        yield* punctuation(".").decode(result.next);
        return read(cursor.source.slice(cursor.offset, result.next.offset), result.next, [
          {
            kind: "Identifier",
            start: cursor.offset,
            end: result.next.offset,
            children: [],
          },
        ]);
      }),
    encode: identifier.encode,
  }),
);

/** A dot inside a quoted identifier belongs to the name, not to its qualifier. */
export const tableReference: Codec<TableReference> = lexeme(
  located(
    "TableReference",
    transform(
      tuple([
        alternatives(identifier, tempSchema),
        optional(prefixed(punctuation("."), identifier)),
      ]),
      {
        decode: ([first, second]): TableReference =>
          second === undefined ? { name: first } : { schema: first, name: second },
        encode: ({ name, schema }: TableReference) =>
          schema === undefined ? ([name, undefined] as const) : ([schema, name] as const),
      },
    ),
  ),
);
