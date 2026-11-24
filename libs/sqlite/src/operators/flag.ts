import { type Codec, optional, prefixed, transform } from "@uncutsql/codec";
import { keyword } from "./keyword.ts";

export const flag = (syntax: Codec<void>): Codec<boolean> =>
  transform(
    optional(
      transform(syntax, {
        decode: () => true as const,
        encode: (_value: true) => undefined,
      }),
    ),
    {
      decode: (value) => value === true,
      encode: (value: boolean) => (value ? (true as const) : undefined),
    },
  );

export const ifNotExists = flag(
  prefixed(keyword("IF"), prefixed(keyword("NOT"), keyword("EXISTS"), " "), " "),
);
