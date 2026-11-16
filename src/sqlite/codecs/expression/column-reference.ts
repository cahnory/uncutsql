import { Effect } from "effect";
import {
  type Codec,
  EncodeError,
  located,
  make,
  optional,
  parseError,
  prefixed,
  read,
} from "../../../codec/index.ts";
import { identifier } from "../identifier.ts";
import { lexeme } from "../../operators/lexeme.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { ColumnReference } from "./types.ts";

const nextPart = optional(prefixed(punctuation("."), identifier));

export const columnReference: Codec<ColumnReference> = lexeme(
  located(
    "ColumnReference",
    make<ColumnReference>({
      decode: (cursor) =>
        Effect.gen(function* () {
          // A blob introducer is not a column named x followed by a string.
          if (/^[xX]'/.test(cursor.source.slice(cursor.offset))) {
            return yield* Effect.fail(parseError(cursor, "column reference"));
          }
          const first = yield* identifier.decode(cursor);
          const second = yield* nextPart.decode(first.next);
          if (second.value === undefined) {
            // These spellings are contextual SQLite literals when unqualified. The
            // literal codec preserves them verbatim for SQLite's later name resolution.
            if (/^(?:TRUE|FALSE)$/i.test(cursor.source.slice(cursor.offset, first.next.offset))) {
              return yield* Effect.fail(parseError(cursor, "quoted or qualified column reference"));
            }
            return read({ _tag: "ColumnReference", parts: [first.value] }, first.next, first.nodes);
          }
          const third = yield* nextPart.decode(second.next);
          const parts: ColumnReference["parts"] =
            third.value === undefined
              ? [first.value, second.value]
              : [first.value, second.value, third.value];
          return read({ _tag: "ColumnReference", parts }, third.next, [
            ...first.nodes,
            ...second.nodes,
            ...third.nodes,
          ]);
        }),
      encode: ({ parts }) =>
        Effect.gen(function* () {
          if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3) {
            return yield* Effect.fail(
              new EncodeError({ message: "A column reference needs one to three identifiers" }),
            );
          }
          const names = yield* Effect.forEach(parts, (name) => identifier.encode(name));
          return names.join(".");
        }),
    }),
  ),
);
