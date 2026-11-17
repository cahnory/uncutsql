import { Effect } from "effect";
import { type Codec, EncodeError, located, make, parseError, read } from "@uncutsql/codec";
import { identifierPart } from "../lexer/characters.ts";
import { lexeme } from "../operators/lexeme.ts";

export interface NumericLiteral {
  readonly _tag: "NumericLiteral";
  /** Unsigned SQL spelling, never a JS number: retain precision and INTEGER/REAL semantics. */
  readonly value: string;
}

const digits = "[0-9](?:_?[0-9])*";
const decimal = `(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?`;
const numeric = new RegExp(`^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|${decimal})`);

const isRepresentable = (value: string): boolean => {
  if (numeric.exec(value)?.[0] !== value) return false;
  if (!/^0x/i.test(value)) return true;
  // SQLite hex integers are 64-bit two's-complement values.
  return value.slice(2).replaceAll("_", "").replace(/^0+/, "").length <= 16;
};

export const numericLiteral: Codec<NumericLiteral> = lexeme(
  located(
    "NumericLiteral",
    make<NumericLiteral>({
      decode: (cursor) => {
        const remaining = cursor.source.slice(cursor.offset);
        if (!/^(?:[0-9]|\.[0-9])/.test(remaining)) {
          return Effect.fail(parseError(cursor, "numeric literal"));
        }
        const value = numeric.exec(remaining)?.[0] ?? "";
        const next = { ...cursor, offset: cursor.offset + value.length };
        const following = cursor.source[next.offset] ?? "";
        if (!isRepresentable(value) || identifierPart.test(following) || following === ".") {
          return Effect.fail(parseError(next, "valid numeric literal", true));
        }
        return Effect.succeed(read({ _tag: "NumericLiteral", value }, next));
      },
      encode: ({ value }) =>
        typeof value === "string" && isRepresentable(value)
          ? Effect.succeed(value)
          : Effect.fail(
              new EncodeError({ message: "Expected an unsigned SQLite numeric literal" }),
            ),
    }),
  ),
);
