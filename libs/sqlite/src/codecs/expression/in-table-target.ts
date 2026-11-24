import { optional, struct, transform } from "@uncutsql/codec";
import type { Codec } from "@uncutsql/codec";
import { repeat } from "@uncutsql/codec";

import { parenthesized } from "../../operators/parenthesized.ts";
import { punctuation } from "../../operators/punctuation.ts";
import { tableReference } from "../table-reference.ts";
import type { Expression, InTableTarget } from "./types.ts";

/** An absent argument list is a table; an empty list is a table-valued function. */
export const inTableTarget = (expression: Codec<Expression>): Codec<InTableTarget> =>
  transform(
    struct({
      table: tableReference,
      arguments: optional(parenthesized(repeat(expression, { separator: punctuation(",", ", ") }))),
    }),
    {
      decode: ({ arguments: args, table }): InTableTarget => ({
        table,
        ...(args === undefined ? {} : { arguments: args }),
      }),
      encode: (value: InTableTarget) => ({ arguments: value.arguments, table: value.table }),
    },
  );
