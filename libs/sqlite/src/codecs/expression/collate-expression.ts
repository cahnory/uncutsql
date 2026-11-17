import { Effect } from "effect";
import { type Cursor, type Read, commit, read } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { identifier } from "../identifier.ts";
import type { CollateExpression, Expression, ExpressionAt } from "./types.ts";

// SQLite binds COLLATE below symbolic unary operators and above concatenation.
export const collatePrecedence = 95;
export const collateOperator = keyword("COLLATE");
export const readCollate = (start: Cursor, operand: Read<Expression>, operator: Read<void>) =>
  Effect.gen(function* () {
    const collation = yield* commit(identifier).decode(operator.next);
    return read<Expression>(
      { _tag: "CollateExpression", operand: operand.value, collation: collation.value },
      collation.next,
      [
        {
          kind: "CollateExpression",
          start: start.offset,
          end: collation.next.offset,
          children: [...operand.nodes, ...operator.nodes, ...collation.nodes],
        },
      ],
    );
  });
export const encodeCollate = (value: CollateExpression, at: ExpressionAt) =>
  Effect.gen(function* () {
    const operand = yield* at(collatePrecedence).encode(value.operand);
    const collation = yield* identifier.encode(value.collation);
    return `${operand} COLLATE ${collation}`;
  });
