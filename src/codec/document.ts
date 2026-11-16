import { Effect } from "effect";
import { type Codec, type SourceNode, ParseError, parseError } from "./model.ts";

export interface Parsed<A> {
  readonly value: A;
  readonly source: string;
  readonly sourceMap: readonly SourceNode[];
}

/** The only layer requiring complete input. It never runs an Effect internally. */
export const document = <A, E, R>(codec: Codec<A, E, R>, trivia?: Codec<void>) => {
  const decodeWithSourceMap = (source: string): Effect.Effect<Parsed<A>, E | ParseError, R> =>
    Effect.gen(function* () {
      let cursor = { source, offset: 0 };
      if (trivia) cursor = (yield* trivia.decode(cursor)).next;
      const result = yield* codec.decode(cursor);
      cursor = result.next;
      if (trivia) cursor = (yield* trivia.decode(cursor)).next;
      if (cursor.offset !== source.length) {
        return yield* Effect.fail(parseError(cursor, "end of input", true));
      }
      return { value: result.value, source, sourceMap: result.nodes };
    });

  return {
    decodeWithSourceMap,
    decode: (source: string) => Effect.map(decodeWithSourceMap(source), (result) => result.value),
    encode: codec.encode,
  };
};
