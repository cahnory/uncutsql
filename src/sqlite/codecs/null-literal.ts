import { type Codec, located, transform } from "../../codec/index.ts";
import { keyword } from "../operators/keyword.ts";
import { lexeme } from "../operators/lexeme.ts";

export interface NullLiteral {
  readonly _tag: "NullLiteral";
}

export const nullLiteral: Codec<NullLiteral> = lexeme(
  located(
    "NullLiteral",
    transform(keyword("NULL"), {
      decode: (): NullLiteral => ({ _tag: "NullLiteral" }),
      encode: (_value: NullLiteral) => undefined,
    }),
  ),
);
