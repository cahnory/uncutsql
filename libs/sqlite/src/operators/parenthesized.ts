import { type Codec, followedBy, prefixed } from "@uncutsql/codec";
import { punctuation } from "./punctuation.ts";

export const parenthesized = <A, E, R>(codec: Codec<A, E, R>): Codec<A, E, R> =>
  prefixed(punctuation("("), followedBy(codec, punctuation(")")));
