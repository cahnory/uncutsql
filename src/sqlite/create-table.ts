import {
  type Codec, type Value, alternatives, document, followedBy, located, optional,
  prefixed, repeat, struct, taggedUnion, transform,
} from "../codec/index.ts";
import { columnType, identifier, keyword, lexeme, punctuation, stringValue, trivia } from "./tokens.ts";

export const stringLiteral = transform(stringValue, {
  decode: (value) => ({ _tag: "StringLiteral" as const, value }),
  encode: (value: { readonly _tag: "StringLiteral"; readonly value: string }) => value.value,
});

const nullLiteral = transform(keyword("NULL"), {
  decode: () => ({ _tag: "NullLiteral" as const }),
  encode: (_value: { readonly _tag: "NullLiteral" }) => undefined,
});

export const literalValue = taggedUnion({ StringLiteral: stringLiteral, NullLiteral: nullLiteral });
export type LiteralValue = Value<typeof literalValue>;

const marker = <const Tag extends string>(tag: Tag, syntax: Codec<void>) => transform(syntax, {
  decode: () => ({ _tag: tag }),
  encode: (_value: { readonly _tag: Tag }) => undefined,
});

const flag = (syntax: Codec<void>): Codec<boolean> => transform(optional(transform(syntax, {
  decode: () => true as const,
  encode: (_value: true) => undefined,
})), {
  decode: (value) => value === true,
  encode: (value: boolean) => value ? true as const : undefined,
});

const columnConstraint = lexeme(located("ColumnConstraint", taggedUnion({
  PrimaryKey: marker("PrimaryKey", prefixed(keyword("PRIMARY"), keyword("KEY"), " ")),
  NotNull: marker("NotNull", prefixed(keyword("NOT"), keyword("NULL"), " ")),
  Unique: marker("Unique", keyword("UNIQUE")),
  Default: transform(prefixed(keyword("DEFAULT"), literalValue, " "), {
    decode: (value) => ({ _tag: "Default" as const, value }),
    encode: (value: { readonly _tag: "Default"; readonly value: LiteralValue }) => value.value,
  }),
})));
export type ColumnConstraint = Value<typeof columnConstraint>;

export const columnDefinition = lexeme(located("ColumnDefinition", struct({
  name: identifier,
  typeName: optional(columnType),
  constraints: repeat(columnConstraint, { join: " " }),
}, " ")));
export type ColumnDefinition = Value<typeof columnDefinition>;

const columns = prefixed(punctuation("("), followedBy(
  repeat(columnDefinition, { min: 1, separator: punctuation(",", ", ") }),
  punctuation(")"),
));

const definition = struct({
  temporary: flag(alternatives(keyword("TEMPORARY"), keyword("TEMP"))),
  tableKeyword: keyword("TABLE"),
  ifNotExists: flag(prefixed(keyword("IF"), prefixed(keyword("NOT"), keyword("EXISTS"), " "), " ")),
  name: identifier,
  columns,
}, " ");

export interface CreateTable {
  readonly _tag: "CreateTable";
  readonly temporary: boolean;
  readonly ifNotExists: boolean;
  readonly name: string;
  readonly columns: readonly ColumnDefinition[];
}

/** Optional on input, canonical semicolon on output. */
const terminator = transform(optional(transform(punctuation(";"), {
  decode: () => true as const,
  encode: (_value: true) => undefined,
})), {
  decode: (): void => undefined,
  encode: (_value: void) => true as const,
});

export const createTableGrammar: Codec<CreateTable> = lexeme(located("CreateTable", followedBy(
  prefixed(keyword("CREATE"), transform(definition, {
    decode: ({ tableKeyword: _, ...value }): CreateTable => ({ _tag: "CreateTable", ...value }),
    encode: ({ _tag: _, ...value }: CreateTable) => ({ ...value, tableKeyword: undefined }),
  }), " "),
  terminator,
)));

export const createTable = document(createTableGrammar, trivia);
