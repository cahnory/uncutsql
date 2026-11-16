import { Effect } from "effect";
import {
  type Codec,
  type Cursor,
  EncodeError,
  located,
  make,
  parseError,
  read,
} from "../../codec/index.ts";
import { identifierPart } from "../lexer/characters.ts";
import { lexeme } from "../operators/lexeme.ts";

export const columnTypes = ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"] as const;
export type ColumnType = (typeof columnTypes)[number];

export const columnType: Codec<ColumnType> = lexeme(
  located(
    "TypeName",
    make({
      decode: (cursor: Cursor) => {
        let end = cursor.offset;
        while (identifierPart.test(cursor.source[end] ?? "")) end++;
        const value = cursor.source.slice(cursor.offset, end).toUpperCase();
        return columnTypes.includes(value as ColumnType)
          ? Effect.succeed(read(value as ColumnType, { ...cursor, offset: end }))
          : Effect.fail(parseError(cursor, columnTypes));
      },
      encode: (value: ColumnType) =>
        columnTypes.includes(value)
          ? Effect.succeed(value)
          : Effect.fail(new EncodeError({ message: `Unsupported column type: ${value}` })),
    }),
  ),
);
