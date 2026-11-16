import { prefixed } from "../../../codec/index.ts";
import { keyword } from "../../operators/keyword.ts";
import { marker } from "../../operators/marker.ts";

export const primaryKeyColumnConstraint = marker(
  "PrimaryKey",
  prefixed(keyword("PRIMARY"), keyword("KEY"), " "),
);
