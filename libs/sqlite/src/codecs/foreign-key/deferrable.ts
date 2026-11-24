import { optional, prefixed, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { keywordChoice } from "../../operators/keyword-choice.ts";
import { keyword } from "../../operators/keyword.ts";

export interface Deferrability {
  readonly deferrable: boolean;
  readonly initially?: "DEFERRED" | "IMMEDIATE";
}

export const deferrability: Codec<Deferrability> = transform(
  struct(
    {
      mode: keywordChoice(["NOT DEFERRABLE", "DEFERRABLE"]),
      initially: optional(
        prefixed(keyword("INITIALLY"), keywordChoice(["DEFERRED", "IMMEDIATE"]), " "),
      ),
    },
    " ",
  ),
  {
    decode: ({ initially, mode }): Deferrability => ({
      deferrable: mode === "DEFERRABLE",
      ...(initially === undefined ? {} : { initially }),
    }),
    encode: (value: Deferrability) => ({
      initially: value.initially,
      mode: value.deferrable ? ("DEFERRABLE" as const) : ("NOT DEFERRABLE" as const),
    }),
  },
);
