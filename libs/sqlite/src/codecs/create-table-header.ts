import { type Codec, alternatives, prefixed, struct, transform } from "@uncutsql/codec";
import { flag } from "../operators/flag.ts";
import { keyword } from "../operators/keyword.ts";
import { tableReference } from "./table-reference.ts";

export interface CreateTableHeader {
  readonly temporary: boolean;
  readonly ifNotExists: boolean;
  readonly name: string;
  readonly schema?: string;
}

export const createTableHeader: Codec<CreateTableHeader> = prefixed(
  keyword("CREATE"),
  transform(
    struct(
      {
        temporary: flag(alternatives(keyword("TEMPORARY"), keyword("TEMP"))),
        tableKeyword: keyword("TABLE"),
        ifNotExists: flag(
          prefixed(keyword("IF"), prefixed(keyword("NOT"), keyword("EXISTS"), " "), " "),
        ),
        reference: tableReference,
      },
      " ",
    ),
    {
      decode: ({ temporary, ifNotExists, reference }): CreateTableHeader => ({
        temporary,
        ifNotExists,
        ...reference,
      }),
      encode: (value: CreateTableHeader) => ({
        temporary: value.temporary,
        ifNotExists: value.ifNotExists,
        tableKeyword: undefined,
        reference: {
          name: value.name,
          ...(value.schema === undefined ? {} : { schema: value.schema }),
        },
      }),
    },
  ),
  " ",
);
