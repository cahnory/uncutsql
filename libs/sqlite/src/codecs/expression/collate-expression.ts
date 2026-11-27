import { Effect } from "effect";

import { commit, read } from "@uncutsql/codec";
import type { Cursor, Read } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import { collationName } from "../identifier.ts";
import type { CollateExpression, Expression, ExpressionAt } from "./types.ts";

// SQLite binds COLLATE below symbolic unary operators and above concatenation.
export const collatePrecedence = 95;
export const collateOperator = keyword("COLLATE");
export const readCollate = (start: Cursor, operand: Read<Expression>, operator: Read<void>) =>
  Effect.gen(function* () {
    const collation = yield* commit(collationName).decode(operator.next);
    return read<Expression>(
      { _tag: "CollateExpression", collation: collation.value, operand: operand.value },
      collation.next,
      [
        {
          children: [...operand.nodes, ...operator.nodes, ...collation.nodes],
          end: collation.next.offset,
          kind: "CollateExpression",
          start: start.offset,
        },
      ],
    );
  });
export const encodeCollate = (value: CollateExpression, at: ExpressionAt) =>
  Effect.gen(function* () {
    const operand = yield* at(collatePrecedence).encode(value.operand);
    const collation = yield* collationName.encode(value.collation);
    return `${operand} COLLATE ${collation}`;
  });
