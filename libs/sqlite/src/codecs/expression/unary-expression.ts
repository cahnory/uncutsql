import { Effect } from "effect";
import { type Codec, commit, located, make, read } from "@uncutsql/codec";
import { lexeme } from "../../operators/lexeme.ts";
import { unaryOperator, unaryPrecedence } from "./operators.ts";
import type { ExpressionAt, UnaryExpression } from "./types.ts";

export const unaryExpression = (at: ExpressionAt): Codec<UnaryExpression> =>
  lexeme(
    located(
      "UnaryExpression",
      make<UnaryExpression>({
        decode: (cursor) =>
          Effect.gen(function* () {
            const operator = yield* unaryOperator.decode(cursor);
            const operand = yield* commit(at(unaryPrecedence[operator.value])).decode(
              operator.next,
            );
            return read(
              { _tag: "UnaryExpression", operator: operator.value, operand: operand.value },
              operand.next,
              [...operator.nodes, ...operand.nodes],
            );
          }),
        encode: (value) =>
          Effect.gen(function* () {
            const operator = yield* unaryOperator.encode(value.operator);
            const operand = yield* at(unaryPrecedence[value.operator]).encode(value.operand);
            // In particular, nested negation must not accidentally become a '--' comment.
            const space = operator === "NOT" || value.operand._tag === "UnaryExpression" ? " " : "";
            return `${operator}${space}${operand}`;
          }),
      }),
    ),
  );
