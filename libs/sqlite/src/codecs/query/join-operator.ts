import { Effect } from "effect";
import {
  type Codec,
  EncodeError,
  tuple,
  make,
  parseError,
  repeat,
  taggedUnion,
  transform,
} from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { JoinOperator } from "./types.ts";

export const joinOperator: Codec<JoinOperator> = (() => {
  const syntax = taggedUnion({
    CommaJoin: transform(punctuation(","), {
      decode: () => ({ _tag: "CommaJoin" as const }),
      encode: (_value: { _tag: "CommaJoin" }) => undefined,
    }),
    KeywordJoin: transform(
      tuple(
        [
          repeat(keywordChoice(["NATURAL", "LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS"]), {
            join: " ",
          }),
          keyword("JOIN"),
        ],
        " ",
      ),
      {
        decode: ([modifiers]) => ({ _tag: "KeywordJoin" as const, modifiers }),
        encode: (value) => [value.modifiers, undefined] as const,
      },
    ),
  });
  const valid = (value: JoinOperator) => {
    if (value._tag === "CommaJoin") return true;
    const modifiers = value.modifiers;
    const side = modifiers.some((word) => word === "LEFT" || word === "RIGHT" || word === "FULL");
    const outer = side || modifiers.includes("OUTER");
    const inner = modifiers.includes("INNER") || modifiers.includes("CROSS");
    return modifiers.length <= 3 && !(inner && outer) && !(outer && !side);
  };
  return make<JoinOperator>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* syntax.decode(cursor);
        if (!valid(result.value))
          return yield* Effect.fail(
            parseError(cursor, "a compatible SQLite join type with at most three modifiers", true),
          );
        return result;
      }),
    encode: (value) =>
      valid(value)
        ? syntax.encode(value)
        : Effect.fail(new EncodeError({ message: "Invalid SQLite join modifiers" })),
  });
})();
