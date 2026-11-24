import { alternatives, prefixed, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";

import { flag, ifNotExists } from "../operators/flag.ts";
import { keyword } from "../operators/keyword.ts";
import { tableReference } from "./table-reference.ts";

export interface CreateTableHeader {
  readonly ifNotExists: boolean;
  readonly name: string;
  readonly schema?: string;
  readonly temporary: boolean;
}

export const createRelationHeader = (
  kind: "TABLE" | "VIEW" | "TRIGGER",
): Codec<CreateTableHeader> =>
  prefixed(
    keyword("CREATE"),
    transform(
      struct(
        {
          temporary: flag(alternatives(keyword("TEMPORARY"), keyword("TEMP"))),
          kindKeyword: keyword(kind),
          ifNotExists,
          reference: tableReference,
        },
        " ",
      ),
      {
        decode: ({ ifNotExists, reference, temporary }): CreateTableHeader => ({
          ifNotExists,
          temporary,
          ...reference,
        }),
        encode: (value: CreateTableHeader) => ({
          ifNotExists: value.ifNotExists,
          kindKeyword: undefined,
          reference: {
            name: value.name,
            ...(value.schema === undefined ? {} : { schema: value.schema }),
          },
          temporary: value.temporary,
        }),
      },
    ),
    " ",
  );

export const createTableHeader = createRelationHeader("TABLE");
