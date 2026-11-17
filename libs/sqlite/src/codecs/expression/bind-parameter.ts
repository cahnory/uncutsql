import { Effect } from "effect";
import { type Codec, EncodeError, located, make, parseError, read } from "@uncutsql/codec";
import { identifierPart } from "../../lexer/characters.ts";
import { lexeme } from "../../operators/lexeme.ts";
import type { BindParameter } from "./types.ts";

// Preserve names and numeric spelling: changing either can change binding identity.
const scan = (source: string, start: number): number => {
  const sigil = source[start];
  let end = start + 1;
  if (sigil === "?") {
    while (/[0-9]/.test(source[end] ?? "")) end++;
    return end;
  }
  if (sigil !== ":" && sigil !== "@" && sigil !== "$") return start;
  let names = 0;
  while (end < source.length) {
    const char = source[end]!;
    if (identifierPart.test(char)) {
      names++;
      end++;
    } else if (source.startsWith("::", end)) end += 2;
    else if (char === "(" && names > 0) {
      end++;
      while (end < source.length && source[end] !== ")" && !/[\t\n\v\f\r \0]/.test(source[end]!))
        end++;
      return source[end] === ")" ? end + 1 : -1;
    } else break;
  }
  return names > 0 ? end : -1;
};
export const bindParameter: Codec<BindParameter> = lexeme(
  located(
    "BindParameter",
    make({
      decode: (cursor) => {
        const end = scan(cursor.source, cursor.offset);
        return end <= cursor.offset
          ? Effect.fail(parseError(cursor, "bind parameter", end === -1))
          : Effect.succeed(
              read(
                { _tag: "BindParameter" as const, value: cursor.source.slice(cursor.offset, end) },
                { ...cursor, offset: end },
              ),
            );
      },
      encode: (value: BindParameter) =>
        typeof value.value === "string" &&
        value.value.length > 0 &&
        scan(value.value, 0) === value.value.length
          ? Effect.succeed(value.value)
          : Effect.fail(new EncodeError({ message: "Invalid bind parameter spelling" })),
    }),
  ),
);
