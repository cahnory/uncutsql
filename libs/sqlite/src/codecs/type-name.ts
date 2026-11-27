import { Effect, Result } from "effect";

import {
  EncodeError,
  located,
  make,
  optional,
  parseError,
  prefixed,
  read,
  repeat,
  struct,
  tuple,
} from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordSequence } from "../operators/keyword-sequence.ts";
import { lexeme } from "../operators/lexeme.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { punctuation } from "../operators/punctuation.ts";
import { typeWordName } from "./identifier.ts";
import { typeParameter } from "./type-parameter.ts";

/** Common spellings, not a whitelist: ordinary SQLite tables allow custom types. */
export const columnTypes = ["INT", "INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", "ANY"] as const;
/** Validated SQL declaration spelling. Quotes and internal trivia can affect affinity. */
export type ColumnType = string;

const generatedPrefix = keywordSequence(["GENERATED", "ALWAYS", "AS"]);

const typeWord = (inColumnDeclaration: boolean) =>
  make<string>({
    decode: (cursor) =>
      Effect.gen(function* () {
        // GENERATED can be a type word or the start of a column constraint.
        if (
          inColumnDeclaration &&
          Result.isSuccess(yield* Effect.result(generatedPrefix.decode(cursor)))
        ) {
          return yield* Effect.fail(parseError(cursor, "type word"));
        }
        const result = yield* typeWordName.decode(cursor);
        return {
          ...result,
          nodes: result.nodes.map((node) => ({ ...node, kind: "TypeWord" })),
        };
      }),
    encode: typeWordName.encode,
  });

const typeName = (inColumnDeclaration: boolean): Codec<ColumnType> => {
  const syntax = struct({
    words: repeat(typeWord(inColumnDeclaration), { join: " ", min: 1 }),
    parameters: optional(
      parenthesized(tuple([typeParameter, optional(prefixed(punctuation(","), typeParameter))])),
    ),
  });

  const codec: Codec<ColumnType> = lexeme(
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
            const parsed = yield* Effect.result(codec.decode({ offset: 0, source: value }));
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
  return codec;
};

export const columnType = typeName(false);
export const columnDeclarationType = typeName(true);
