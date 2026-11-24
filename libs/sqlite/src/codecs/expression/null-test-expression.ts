import { read, transform } from "@uncutsql/codec";
import type { Cursor, Read } from "@uncutsql/codec";

import { keywordChoice } from "../../operators/keyword-choice.ts";
import type { Expression, NullTestExpression } from "./types.ts";

export const nullTestPrecedence = 40;
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
    { _tag: "NullTestExpression", operand: operand.value, operator: operator.value },
    operator.next,
    [
      {
        children: [...operand.nodes, ...operator.nodes],
        end: operator.next.offset,
        kind: "NullTestExpression",
        start: start.offset,
      },
    ],
  );
