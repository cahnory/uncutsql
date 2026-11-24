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
import { constraintEntry, constraintLabel } from "../operators/named-constraint.ts";
import { punctuation } from "../operators/punctuation.ts";
import { parenthesized } from "../operators/parenthesized.ts";
import { columnDefinition, columnWithLabel, type ColumnDefinition } from "./column-definition.ts";
import { tableConstraint, type TableConstraint } from "./table-constraint.ts";

export interface TableDefinition {
  readonly columns: readonly ColumnDefinition[];
  readonly tableConstraints: readonly TableConstraint[];
}

const tableConstraintEntry = constraintEntry(tableConstraint);

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
        const first = yield* columnWithLabel.decode(cursor);
        const columns: ColumnDefinition[] = [first.value.column];
        const tableConstraints: TableConstraint[] = [];
        const nodes: SourceNode[] = [...first.nodes];
        let next = first.next;
        let label = first.value.label;
        let seenTableConstraint = false;
        while (true) {
          const separator = yield* comma.decode(next);
          if (separator.value === undefined && !seenTableConstraint) break;
          const constraint = yield* Effect.result(tableConstraintEntry.decode(separator.next));
          if (Result.isSuccess(constraint)) {
            if (seenTableConstraint && separator.value !== undefined) label = undefined;
            seenTableConstraint = true;
            const value = constraint.success.value;
            if (typeof value === "string") {
              label = value;
            } else {
              label = value.name ?? label;
              tableConstraints.push(label === undefined ? value : { ...value, name: label });
            }
            nodes.push(...constraint.success.nodes);
            next = constraint.success.next;
          } else {
            if (separator.value === undefined && !constraint.failure.committed) break;
            if (constraint.failure.committed || seenTableConstraint) {
              return yield* Effect.fail(constraint.failure);
            }
            const column = yield* commit(columnWithLabel).decode(separator.next);
            columns.push(column.value.column);
            label = column.value.label;
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
        // The first table constraint inherits the final column label. An empty
        // table constraint followed by a comma clears it for an unnamed body.
        const finalLabel = value.columns.at(-1)?.constraints.at(-1)?.name;
        if (
          finalLabel !== undefined &&
          constraints.length &&
          value.tableConstraints[0]?.name === undefined
        ) {
          columns.push(yield* constraintLabel.encode(finalLabel));
        }
        return [...columns, ...constraints].join(", ");
      }),
  }),
);
