import { Effect } from "effect";

import type { ParseError } from "./model.ts";
import { parseError } from "./model.ts";
import type { Codec, SourceNode } from "./model.ts";

export interface Parsed<A> {
  readonly source: string;
  readonly sourceMap: readonly SourceNode[];
  readonly value: A;
}

/** The only layer requiring complete input. It never runs an Effect internally. */
export const document = <A, E, R>(codec: Codec<A, E, R>, trivia?: Codec<void>) => {
  const decodeWithSourceMap = (source: string): Effect.Effect<Parsed<A>, E | ParseError, R> =>
    Effect.gen(function* () {
      let cursor = { offset: 0, source };
      if (trivia) {
        cursor = (yield* trivia.decode(cursor)).next;
      }
      const result = yield* codec.decode(cursor);
      cursor = result.next;
      if (trivia) {
        cursor = (yield* trivia.decode(cursor)).next;
      }
      if (cursor.offset !== source.length) {
        return yield* Effect.fail(parseError(cursor, "end of input", true));
      }
      return { source, sourceMap: result.nodes, value: result.value };
    });

  return {
    decode: (source: string) => Effect.map(decodeWithSourceMap(source), (result) => result.value),
    decodeWithSourceMap,
    encode: codec.encode,
  };
};
