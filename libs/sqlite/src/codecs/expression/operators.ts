import { Effect } from "effect";

import {
  alternatives,
  EncodeError,
  located,
  make,
  parseError,
  read,
  transform,
  tuple,
} from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keyword } from "../../operators/keyword.ts";
import { lexeme } from "../../operators/lexeme.ts";

/** One precedence table drives both parsing and printing. Larger binds tighter. */
export const binaryPrecedence = {
  "-": 70,
  "->": 90,
  "->>": 90,
  "!=": 40,
  "*": 80,
  "/": 80,
  "&": 60,
  "%": 80,
  "+": 70,
  "<": 50,
  "<<": 60,
  "<=": 50,
  "=": 40,
  ">": 50,
  ">=": 50,
  ">>": 60,
  "|": 60,
  "||": 90,
  AND: 20,
  IS: 40,
  "IS NOT": 40,
  OR: 10,
} as const;
export type BinaryOperator = keyof typeof binaryPrecedence;

export const unaryPrecedence = { "-": 100, "+": 100, "~": 100, NOT: 30 } as const;
export type UnaryOperator = keyof typeof unaryPrecedence;
export const primaryPrecedence = 110;

// Match a complete symbolic operator before checking its role. In particular,
// never interpret the first '<' in '<<' as a comparison, or '-' in '->' as subtraction.
const symbolPattern = /^(?:->>|->|\|\||<<|>>|<=|>=|==|!=|<>|[+~*/%&|<>=-])/;
const symbol = <A extends string>(
  spellings: Readonly<Record<string, A>>,
  allowed: readonly A[],
): Codec<A> =>
  lexeme(
    make<A>({
      decode: (cursor) => {
        const text = symbolPattern.exec(cursor.source.slice(cursor.offset))?.[0];
        const value = text === undefined ? undefined : spellings[text];
        return value === undefined
          ? Effect.fail(parseError(cursor, allowed))
          : Effect.succeed(read(value, { ...cursor, offset: cursor.offset + text!.length }));
      },
      encode: (value) =>
        allowed.includes(value)
          ? Effect.succeed(value)
          : Effect.fail(new EncodeError({ message: `Unsupported operator: ${value}` })),
    }),
  );

const wordOperator = <A extends string>(spelling: string, value: A): Codec<A> =>
  transform(tuple(spelling.split(" ").map(keyword), " "), {
    decode: () => value,
    encode: (_value: A) => spelling.split(" ").map(() => undefined),
  });

const symbols = {
  "-": "-",
  "->": "->",
  "->>": "->>",
  "!=": "!=",
  "*": "*",
  "/": "/",
  "&": "&",
  "%": "%",
  "+": "+",
  "<": "<",
  "<<": "<<",
  "<=": "<=",
  "<>": "!=",
  "=": "=",
  "==": "=",
  ">": ">",
  ">=": ">=",
  ">>": ">>",
  "|": "|",
  "||": "||",
} as const satisfies Record<string, BinaryOperator>;

// All alternatives below have a shared encoder; decode normalizes SQL aliases.
const binaryWords: readonly [string, BinaryOperator][] = [
  ["IS NOT DISTINCT FROM", "IS"],
  ["IS DISTINCT FROM", "IS NOT"],
  ["IS NOT", "IS NOT"],
  ["IS", "IS"],
  ["AND", "AND"],
  ["OR", "OR"],
];
const binaryEncode = (operator: BinaryOperator) =>
  Object.hasOwn(binaryPrecedence, operator)
    ? Effect.succeed(operator)
    : Effect.fail(new EncodeError({ message: `Unsupported binary operator: ${operator}` }));

export const binaryOperator: Codec<BinaryOperator> = lexeme(
  located(
    "BinaryOperator",
    alternatives(
      make<BinaryOperator>({
        decode: symbol(symbols, Object.values(symbols)).decode,
        encode: binaryEncode,
      }),
      ...binaryWords.map(([spelling, value]) =>
        make<BinaryOperator>({
          decode: wordOperator(spelling, value).decode,
          encode: binaryEncode,
        }),
      ),
    ),
  ),
);

const unaryEncode = (operator: UnaryOperator) =>
  Object.hasOwn(unaryPrecedence, operator)
    ? Effect.succeed(operator)
    : Effect.fail(new EncodeError({ message: `Unsupported unary operator: ${operator}` }));

export const unaryOperator: Codec<UnaryOperator> = lexeme(
  located(
    "UnaryOperator",
    alternatives(
      make<UnaryOperator>({
        decode: symbol({ "-": "-", "+": "+", "~": "~" }, ["+", "-", "~"]).decode,
        encode: unaryEncode,
      }),
      make<UnaryOperator>({ decode: wordOperator("NOT", "NOT").decode, encode: unaryEncode }),
    ),
  ),
);
