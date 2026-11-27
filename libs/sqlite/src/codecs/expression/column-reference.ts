import { Effect } from "effect";

import { EncodeError, located, make, optional, parseError, prefixed, read } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { lexeme } from "../../operators/lexeme.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { identifier, nameIdentifier, qualifierName } from "../identifier.ts";
import type { ColumnReference } from "./types.ts";

const nextPart = optional(prefixed(punctuation("."), nameIdentifier));

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
          const first = yield* qualifierName.decode(cursor);
          const second = yield* nextPart.decode(first.next);
          if (second.value === undefined) {
            // Single-quoted tokens and bare TRUE/FALSE are expressions on their own.
            // qualifierName already excludes the current date/time literals.
            const token = cursor.source.slice(cursor.offset, first.next.offset);
            if (token.startsWith("'") || /^(?:TRUE|FALSE)$/i.test(token)) {
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
