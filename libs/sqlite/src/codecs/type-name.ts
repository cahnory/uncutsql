import { Effect, Result } from "effect";
import {
  type Codec,
  EncodeError,
  located,
  make,
  optional,
  prefixed,
  read,
  repeat,
  struct,
  tuple,
} from "@uncutsql/codec";
import { lexeme } from "../operators/lexeme.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { identifier } from "./identifier.ts";
import { typeParameter } from "./type-parameter.ts";

/** Common spellings, not a whitelist: ordinary SQLite tables allow custom types. */
export const columnTypes = ["INT", "INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", "ANY"] as const;
/** Validated SQL declaration spelling. Quotes and internal trivia can affect affinity. */
export type ColumnType = string;

const typeWord = make<string>({
  decode: (cursor) =>
    Effect.map(identifier.decode(cursor), (result) => ({
      ...result,
      nodes: result.nodes.map((node) => ({ ...node, kind: "TypeWord" })),
    })),
  encode: identifier.encode,
});

const syntax = struct({
  words: repeat(typeWord, { min: 1, join: " " }),
  parameters: optional(
    parenthesized(tuple([typeParameter, optional(prefixed(punctuation(","), typeParameter))])),
  ),
});

export const columnType: Codec<ColumnType> = lexeme(
  located(
    "TypeName",
    make<ColumnType>({
      decode: (cursor) =>
        Effect.map(syntax.decode(cursor), (result) =>
          read(cursor.source.slice(cursor.offset, result.next.offset), result.next, result.nodes),
        ),
      encode: (value) =>
        Effect.gen(function* () {
          if (typeof value !== "string") {
            return yield* Effect.fail(
              new EncodeError({ message: "Expected a SQLite type declaration" }),
            );
          }
          // Validate the complete grammar before emitting the retained spelling. This
          // prevents a constructed type from injecting a constraint or statement.
          const parsed = yield* Effect.result(columnType.decode({ source: value, offset: 0 }));
          if (
            Result.isFailure(parsed) ||
            parsed.success.next.offset !== value.length ||
            parsed.success.value !== value
          ) {
            return yield* Effect.fail(
              new EncodeError({ message: `Invalid SQLite type declaration: ${value}` }),
            );
          }
          return value;
        }),
    }),
  ),
);
