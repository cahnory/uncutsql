import { type Codec, located, transform } from "../../codec/index.ts";
import { quoted } from "../lexer/quoted.ts";
import { lexeme } from "../operators/lexeme.ts";

export interface StringLiteral {
  readonly _tag: "StringLiteral";
  readonly value: string;
}

export const stringValue = lexeme(located("StringLiteral", quoted("'")));
export const stringLiteral: Codec<StringLiteral> = transform(stringValue, {
  decode: (value): StringLiteral => ({ _tag: "StringLiteral", value }),
  encode: (value: StringLiteral) => value.value,
});
