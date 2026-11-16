import { type Codec, followedBy, prefixed } from "../../codec/index.ts";
import { punctuation } from "./punctuation.ts";

export const parenthesized = <A, E, R>(codec: Codec<A, E, R>): Codec<A, E, R> =>
  prefixed(punctuation("("), followedBy(codec, punctuation(")")));
