import { taggedUnion, type Value } from "@uncutsql/codec";
import { blobLiteral } from "./blob-literal.ts";
import { keywordLiteral } from "./keyword-literal.ts";
import { nullLiteral } from "./null-literal.ts";
import { numericLiteral } from "./numeric-literal.ts";
import { stringLiteral } from "./string-literal.ts";

export const literalValue = taggedUnion({
  BlobLiteral: blobLiteral,
  NumericLiteral: numericLiteral,
  StringLiteral: stringLiteral,
  NullLiteral: nullLiteral,
  KeywordLiteral: keywordLiteral,
});
export type LiteralValue = Value<typeof literalValue>;
