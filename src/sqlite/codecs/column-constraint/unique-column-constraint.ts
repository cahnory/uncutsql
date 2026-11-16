import { keyword } from "../../operators/keyword.ts";
import { marker } from "../../operators/marker.ts";

export const uniqueColumnConstraint = marker("Unique", keyword("UNIQUE"));
