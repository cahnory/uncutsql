import { type Codec, optional, transform } from "@uncutsql/codec";

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
