import { Effect } from "effect";
import { type Codec, make } from "./model.ts";

/** Opt-in rule observability. Callers choose the logger, level and span exporter. */
export const observe = <A, E, R>(name: string, codec: Codec<A, E, R>): Codec<A, E, R> => make({
  decode: (cursor) => codec.decode(cursor).pipe(
    Effect.tap((result) => Effect.logDebug("Decoded", { end: result.next.offset })),
    Effect.annotateLogs({ codec: name, operation: "decode", offset: cursor.offset }),
    Effect.withSpan(`${name}.decode`),
  ),
  encode: (value) => codec.encode(value).pipe(
    Effect.tap((sql) => Effect.logDebug("Encoded", { length: sql.length })),
    Effect.annotateLogs({ codec: name, operation: "encode" }),
    Effect.withSpan(`${name}.encode`),
  ),
});
