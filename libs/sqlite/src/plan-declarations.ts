import { Effect } from "effect";
import { EncodeError } from "@uncutsql/codec";
import type { DatabaseView } from "@uncutsql/core";
import { tableKey, tableIdentity } from "./schema-identity.ts";

export const planDeclarations = <T extends Parameters<typeof tableIdentity>[0]>(
  before: readonly T[],
  after: readonly T[],
  changes: readonly { identity: DatabaseView["identity"]; drop: boolean; create: boolean }[],
  suspend: (declaration: T) => boolean,
) =>
  Effect.gen(function* () {
    const byKey = (items: readonly T[]) =>
      new Map(items.map((item) => [tableKey(tableIdentity(item)), item]));
    const retained = byKey(before);
    const targets = byKey(after);
    const drops = byKey(before.filter(suspend));
    const creates = new Map(drops);
    for (const change of changes) {
      const key = tableKey({ schema: change.identity.catalog ?? "", name: change.identity.name });
      if (change.drop) {
        const old = retained.get(key);
        if (!old)
          return yield* Effect.fail(
            new EncodeError({ message: `Missing source declaration ${key} in migration context` }),
          );
        drops.set(key, old);
        creates.delete(key);
        retained.delete(key);
      }
      if (change.create) {
        const target = targets.get(key);
        if (!target || retained.has(key))
          return yield* Effect.fail(
            new EncodeError({ message: `Invalid target declaration ${key} in migration context` }),
          );
        creates.set(key, target);
        retained.set(key, target);
      }
    }
    return {
      drops: [...drops.values()],
      creates: [...creates.values()],
      retained: [...retained.values()],
    };
  });
