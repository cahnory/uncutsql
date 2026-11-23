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
  struct,
} from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import type { Expression, RaiseExpression } from "./types.ts";

export const raiseExpression = (expression: Codec<Expression>): Codec<RaiseExpression> => {
  const syntax = prefixed(
    keyword("RAISE"),
    parenthesized(
      struct({
        action: keywordChoice(["IGNORE", "ROLLBACK", "ABORT", "FAIL"]),
        message: optional(prefixed(punctuation(",", ", "), expression)),
      }),
    ),
  );
  return located(
    "RaiseExpression",
    make<RaiseExpression>({
      decode: (cursor) =>
        Effect.gen(function* () {
          const result = yield* syntax.decode(cursor);
          const { action, message } = result.value;
          if ((action === "IGNORE") !== (message === undefined)) {
            return yield* Effect.fail(
              parseError(
                cursor,
                "IGNORE without a message, or ROLLBACK/ABORT/FAIL with a message",
                true,
              ),
            );
          }
          const value: RaiseExpression =
            action === "IGNORE"
              ? { _tag: "RaiseExpression", action }
              : { _tag: "RaiseExpression", action, message: message! };
          return read(value, result.next, result.nodes);
        }),
      encode: (value) =>
        (value.action === "IGNORE") !== (value.message === undefined)
          ? Effect.fail(
              new EncodeError({
                message: "RAISE requires no message for IGNORE and a message for other actions",
              }),
            )
          : syntax.encode({ action: value.action, message: value.message }),
    }),
  );
};
