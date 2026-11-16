import { type Cursor, type Read, read, transform } from "../../../codec/index.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";
import type { Expression, NullTestExpression } from "./types.ts";

export const nullTestPrecedence = 35;
export const nullTestOperator = transform(keywordChoice(["ISNULL", "NOTNULL", "NOT NULL"]), {
  decode: (value): NullTestExpression["operator"] => (value === "NOT NULL" ? "NOTNULL" : value),
  encode: (value: NullTestExpression["operator"]) => value,
});

export const readNullTest = (
  start: Cursor,
  operand: Read<Expression>,
  operator: Read<NullTestExpression["operator"]>,
): Read<Expression> =>
  read(
    { _tag: "NullTestExpression", operator: operator.value, operand: operand.value },
    operator.next,
    [
      {
        kind: "NullTestExpression",
        start: start.offset,
        end: operator.next.offset,
        children: [...operand.nodes, ...operator.nodes],
      },
    ],
  );
