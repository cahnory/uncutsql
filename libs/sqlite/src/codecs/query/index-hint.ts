import { prefixed, taggedUnion, transform } from "@uncutsql/codec";
import { keywordSequence } from "../../operators/keyword-sequence.ts";
import { nameIdentifier } from "../identifier.ts";

export const indexHint = taggedUnion({
  IndexedBy: transform(prefixed(keywordSequence(["INDEXED", "BY"]), nameIdentifier, " "), {
    decode: (name) => ({ _tag: "IndexedBy" as const, name }),
    encode: (value) => value.name,
  }),
  NotIndexed: transform(keywordSequence(["NOT", "INDEXED"]), {
    decode: () => ({ _tag: "NotIndexed" as const }),
    encode: (_value: { readonly _tag: "NotIndexed" }) => undefined,
  }),
});
