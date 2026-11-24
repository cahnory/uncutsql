import { Data, Effect } from "effect";

export interface Cursor {
  /** Zero-based UTF-16 offset. */
  readonly offset: number;
  readonly source: string;
}

/** A separate syntax tree: semantic values never contain parent links or source text. */
export interface SourceNode {
  readonly children: readonly SourceNode[];
  readonly end: number;
  readonly kind: string;
  readonly start: number;
}

export interface Read<A> {
  readonly next: Cursor;
  readonly nodes: readonly SourceNode[];
  readonly value: A;
}

export class ParseError extends Data.TaggedError("ParseError")<{
  readonly column: number;
  readonly committed: boolean;
  readonly expected: readonly string[];
  readonly found: string;
  readonly line: number;
  readonly offset: number;
}> {
  override get message(): string {
    return `Expected ${this.expected.join(" or ")} at ${this.line}:${this.column}, found ${this.found}`;
  }
}

export class EncodeError extends Data.TaggedError("EncodeError")<{
  readonly message: string;
}> {}

export interface Codec<A, E = never, R = never> {
  readonly decode: (cursor: Cursor) => Effect.Effect<Read<A>, ParseError | E, R>;
  readonly encode: (value: A) => Effect.Effect<string, EncodeError | E, R>;
}

// Existential codec type, confined to heterogeneous combinator implementation.
// Public combinators recover each member's exact value, errors and requirements.
export type AnyCodec = Codec<any, any, any>;
export type Value<C> = C extends Codec<infer A, any, any> ? A : never;
export type Errors<C> = C extends Codec<any, infer E, any> ? E : never;
export type Requirements<C> = C extends Codec<any, any, infer R> ? R : never;

/** Suspend callbacks so codec construction and effect construction have no side effects. */
export const make = <A, E = never, R = never>(codec: Codec<A, E, R>): Codec<A, E, R> => ({
  decode: (cursor) => Effect.suspend(() => codec.decode(cursor)),
  encode: (value) => Effect.suspend(() => codec.encode(value)),
});

export const read = <A>(value: A, next: Cursor, nodes: readonly SourceNode[] = []): Read<A> => ({
  next,
  nodes,
  value,
});

export const parseError = (
  cursor: Cursor,
  expected: string | readonly string[],
  committed = false,
): ParseError => {
  const lines = cursor.source.slice(0, cursor.offset).split(/\r\n|\r|\n/);
  return new ParseError({
    column: (lines.at(-1)?.length ?? 0) + 1,
    committed,
    expected: typeof expected === "string" ? [expected] : expected,
    found:
      cursor.offset === cursor.source.length
        ? "end of input"
        : JSON.stringify(cursor.source.slice(cursor.offset, cursor.offset + 16)),
    line: lines.length,
    offset: cursor.offset,
  });
};

export const commitError = (error: ParseError): ParseError =>
  new ParseError({ ...error, committed: true });

export const mergeErrors = (left: ParseError, right: ParseError): ParseError => {
  if (left.offset !== right.offset) {
    return left.offset > right.offset ? left : right;
  }
  return new ParseError({ ...left, expected: [...new Set([...left.expected, ...right.expected])] });
};
