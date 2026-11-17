import { Effect, Result } from "effect";
import {
  type Codec,
  type SourceNode,
  EncodeError,
  commit,
  make,
  optional,
  read,
  transform,
} from "@uncutsql/codec";
import { punctuation } from "../operators/punctuation.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { columnDefinition, type ColumnDefinition } from "./column-definition.ts";
import { tableConstraint, type TableConstraint } from "./table-constraint.ts";

export interface TableDefinition {
  readonly columns: readonly ColumnDefinition[];
  readonly tableConstraints: readonly TableConstraint[];
}

const comma = optional(
  transform(punctuation(",", ", "), {
    decode: () => true as const,
    encode: (_value: true) => undefined,
  }),
);

/** SQLite requires at least one column and puts table constraints after columns. */
export const tableDefinition: Codec<TableDefinition> = parenthesized(
  make<TableDefinition>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const first = yield* columnDefinition.decode(cursor);
        const columns: ColumnDefinition[] = [first.value];
        const tableConstraints: TableConstraint[] = [];
        const nodes: SourceNode[] = [...first.nodes];
        let next = first.next;
        while (true) {
          const separator = yield* comma.decode(next);
          if (separator.value === undefined) break;
          const constraint = yield* Effect.result(tableConstraint.decode(separator.next));
          if (Result.isSuccess(constraint)) {
            tableConstraints.push(constraint.success.value);
            nodes.push(...constraint.success.nodes);
            next = constraint.success.next;
          } else {
            if (constraint.failure.committed || tableConstraints.length > 0) {
              return yield* Effect.fail(constraint.failure);
            }
            const column = yield* commit(columnDefinition).decode(separator.next);
            columns.push(column.value);
            nodes.push(...column.nodes);
            next = column.next;
          }
        }
        return read({ columns, tableConstraints }, next, nodes);
      }),
    encode: (value) =>
      Effect.gen(function* () {
        if (value.columns.length === 0) {
          return yield* Effect.fail(
            new EncodeError({ message: "A table needs at least one column" }),
          );
        }
        const columns = yield* Effect.forEach(value.columns, columnDefinition.encode);
        const constraints = yield* Effect.forEach(value.tableConstraints, tableConstraint.encode);
        return [...columns, ...constraints].join(", ");
      }),
  }),
);
