import { prefixed, transform } from "@uncutsql/codec";
import { keyword } from "../operators/keyword.ts";
import { expression } from "./expression.ts";
import { query } from "./query/query.ts";
import type { Query } from "./query/types.ts";
import type { CreateTableHeader } from "./create-table-header.ts";

export interface CreateTableAs extends CreateTableHeader {
  readonly _tag: "CreateTableAs";
  readonly query: Query;
}

export const createTableAsDefinition = transform(
  prefixed(keyword("AS"), query(expression, true), " "),
  {
    decode: (query) => ({ _tag: "CreateTableAs" as const, query }),
    encode: (value: Pick<CreateTableAs, "_tag" | "query">) => value.query,
  },
);
