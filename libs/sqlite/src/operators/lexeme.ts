import { Effect } from "effect";
import { type Codec, make } from "@uncutsql/codec";
import { trivia } from "./trivia.ts";

/** Skip leading trivia outside the located codec, keeping spans on actual tokens. */
export const lexeme = <A, E, R>(codec: Codec<A, E, R>): Codec<A, E, R> =>
  make({
    decode: (cursor) =>
      Effect.flatMap(trivia.decode(cursor), (result) => codec.decode(result.next)),
    encode: codec.encode,
  });
