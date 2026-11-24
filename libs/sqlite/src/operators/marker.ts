import { transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

export const marker = <const Tag extends string>(tag: Tag, syntax: Codec<void>) =>
  transform(syntax, {
    decode: () => ({ _tag: tag }),
    encode: (_value: { readonly _tag: Tag }) => undefined,
  });
