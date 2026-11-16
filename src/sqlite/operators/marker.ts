import { type Codec, transform } from "../../codec/index.ts";

export const marker = <const Tag extends string>(tag: Tag, syntax: Codec<void>) =>
  transform(syntax, {
    decode: () => ({ _tag: tag }),
    encode: (_value: { readonly _tag: Tag }) => undefined,
  });
