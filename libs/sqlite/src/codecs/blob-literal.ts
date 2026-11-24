import { Effect } from "effect";

import { EncodeError, located, make, parseError, read } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { lexeme } from "../operators/lexeme.ts";

export interface BlobLiteral {
  readonly _tag: "BlobLiteral";
  /** Hexadecimal byte pairs. Retaining spelling avoids an implicit AST normalization. */
  readonly value: string;
}

export const blobLiteral: Codec<BlobLiteral> = lexeme(
  located(
    "BlobLiteral",
    make<BlobLiteral>({
      decode: (cursor) => {
        if (!/^[xX]'/.test(cursor.source.slice(cursor.offset, cursor.offset + 2))) {
          return Effect.fail(parseError(cursor, "blob literal"));
        }
        let end = cursor.offset + 2;
        while (/[0-9a-fA-F]/.test(cursor.source[end] ?? "")) {
          end++;
        }
        const value = cursor.source.slice(cursor.offset + 2, end);
        if (cursor.source[end] !== "'" || value.length % 2 !== 0) {
          return Effect.fail(
            parseError(
              { ...cursor, offset: end },
              "hexadecimal byte pairs and closing quote",
              true,
            ),
          );
        }
        return Effect.succeed(read({ _tag: "BlobLiteral", value }, { ...cursor, offset: end + 1 }));
      },
      encode: ({ value }) =>
        typeof value === "string" && /^(?:[0-9a-fA-F]{2})*$/.test(value)
          ? Effect.succeed(`X'${value}'`)
          : Effect.fail(new EncodeError({ message: "Expected hexadecimal byte pairs" })),
    }),
  ),
);
