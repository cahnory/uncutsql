import { prefixed } from "../../../codec/index.ts";
import { keyword } from "../../operators/keyword.ts";
import { marker } from "../../operators/marker.ts";

export const notNullColumnConstraint = marker(
  "NotNull",
  prefixed(keyword("NOT"), keyword("NULL"), " "),
);
