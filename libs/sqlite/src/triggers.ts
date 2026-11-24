import { Effect } from "effect";

import { EncodeError } from "@uncutsql/codec";
import { schemaValueEqual, tableKey } from "@uncutsql/core";
import type { DatabaseSchema, DatabaseTrigger } from "@uncutsql/core";

import { createTrigger } from "./codecs/create-trigger.ts";
import type { CreateTrigger } from "./codecs/create-trigger.ts";
import { foldIdentifier } from "./schema-identity.ts";
import { semanticValue, syntaxValue } from "./schema-value.ts";

const definition = ({ actions, event, timing, when }: CreateTrigger) =>
  semanticValue({ actions, event, timing: timing ?? "BEFORE", when });

const relations = (database: DatabaseSchema) => [...database.tables, ...(database.views ?? [])];

export const triggerModel = (trigger: CreateTrigger, database: DatabaseSchema) =>
  Effect.gen(function* () {
    const name = foldIdentifier(trigger.target.name);
    const scope = trigger.schema === undefined ? undefined : foldIdentifier(trigger.schema);
    const temporary = trigger.temporary || scope === "temp";
    const targetScope =
      trigger.target.schema === undefined ? undefined : foldIdentifier(trigger.target.schema);
    const candidates = relations(database).filter((r) => r.identity.name === name);
    const defaultScope =
      scope && !temporary
        ? scope
        : candidates.some((r) => r.identity.catalog === "temp")
          ? "temp"
          : "main";
    const target =
      candidates.find((r) => r.identity.catalog === (targetScope ?? defaultScope)) ??
      (temporary && !targetScope && candidates.length === 1 ? candidates[0] : undefined);
    const catalog = scope ?? (temporary || target?.identity.catalog === "temp" ? "temp" : "main");
    if (
      !target ||
      (trigger.temporary && catalog !== "temp") ||
      (catalog !== "temp" && catalog !== target.identity.catalog) ||
      "query" in target !== (trigger.timing === "INSTEAD OF") ||
      /^sqlite_/i.test(trigger.name)
    ) {
      return yield* Effect.fail(
        new EncodeError({
          message: `Invalid SQLite trigger ${trigger.name} on ${trigger.target.name}`,
        }),
      );
    }
    return {
      definition: definition(trigger),
      identity: { catalog, name: foldIdentifier(trigger.name) },
      name: trigger.name,
      target: target.identity,
    } satisfies DatabaseTrigger;
  });

export const triggersFromDatabaseSchema = (database: DatabaseSchema) =>
  Effect.forEach(database.triggers ?? [], (trigger) =>
    Effect.gen(function* () {
      const owner = relations(database).find(
        (r) => tableKey(r.identity) === tableKey(trigger.target),
      );
      const catalog = trigger.identity.catalog;
      if (
        !owner ||
        !catalog ||
        trigger.identity.schema !== undefined ||
        foldIdentifier(catalog) !== catalog ||
        foldIdentifier(trigger.name) !== trigger.identity.name
      ) {
        return yield* Effect.fail(
          new EncodeError({
            message: `Invalid SQLite trigger identity or target for ${trigger.name}`,
          }),
        );
      }
      const ast = {
        ...(syntaxValue(trigger.definition) as Pick<
          CreateTrigger,
          "timing" | "event" | "when" | "actions"
        >),
        _tag: "CreateTrigger",
        forEachRow: false,
        ifNotExists: false,
        name: trigger.name,
        schema: catalog,
        target: { name: owner.name, schema: trigger.target.catalog },
        temporary: false,
      } as CreateTrigger;
      const parsed = yield* createTrigger.encode(ast).pipe(
        Effect.flatMap(createTrigger.decode),
        Effect.mapError((error) => new EncodeError({ message: error.message })),
        Effect.catchDefect(() =>
          Effect.fail(new EncodeError({ message: "Invalid SQLite trigger definition" })),
        ),
      );
      const model = yield* triggerModel(parsed, database);
      if (!schemaValueEqual(model.definition, trigger.definition)) {
        return yield* Effect.fail(
          new EncodeError({ message: "Invalid SQLite trigger definition in snapshot" }),
        );
      }
      return parsed;
    }),
  );
