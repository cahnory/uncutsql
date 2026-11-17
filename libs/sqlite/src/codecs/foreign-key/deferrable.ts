import { type Codec, optional, prefixed, struct, transform } from "@uncutsql/codec";
import { keyword } from "../../operators/keyword.ts";
import { keywordChoice } from "../../operators/keyword-choice.ts";

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
    decode: ({ mode, initially }): Deferrability => ({
      deferrable: mode === "DEFERRABLE",
      ...(initially === undefined ? {} : { initially }),
    }),
    encode: (value: Deferrability) => ({
      mode: value.deferrable ? ("DEFERRABLE" as const) : ("NOT DEFERRABLE" as const),
      initially: value.initially,
    }),
  },
);
