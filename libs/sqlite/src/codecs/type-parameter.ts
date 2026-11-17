import { Effect } from "effect";
import {
  type Codec,
  type Value,
  EncodeError,
  make,
  parseError,
  taggedUnion,
} from "@uncutsql/codec";
import { numericLiteral } from "./numeric-literal.ts";
import { signedNumber } from "./signed-number.ts";

const number = taggedUnion({ NumericLiteral: numericLiteral, UnaryExpression: signedNumber });
type TypeParameter = Value<typeof number>;
const spelling = (value: TypeParameter) =>
  value._tag === "NumericLiteral" ? value.value : value.operand.value;

/** Type dimensions use signed-number syntax, not general expressions. SQLite's
 * type-name production does not accept the digit-separator numeric token. */
export const typeParameter: Codec<TypeParameter> = make<TypeParameter>({
  decode: (cursor) =>
    Effect.flatMap(number.decode(cursor), (result) =>
      spelling(result.value).includes("_")
        ? Effect.fail(parseError(cursor, "type dimension without digit separators", true))
        : Effect.succeed(result),
    ),
  encode: (value) =>
    spelling(value).includes("_")
      ? Effect.fail(new EncodeError({ message: "Type dimensions do not accept digit separators" }))
      : number.encode(value),
});
