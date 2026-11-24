import { Effect, Result } from "effect";
import { type Codec, type Cursor, make, parseError } from "@uncutsql/codec";
import { nameWithKeywords } from "../codecs/identifier.ts";
import { windowLookaheadKeywords } from "../lexer/keywords.ts";
import { keyword } from "./keyword.ts";
import { skipSqliteTrivia } from "./trivia.ts";

const followingName = nameWithKeywords(windowLookaheadKeywords);
const as = keyword("AS");

export const startsWindowSyntax = (word: string, before: Cursor, after: Cursor) =>
  Effect.gen(function* () {
    if (word !== "WINDOW") {
      // Codecs consume leading trivia, leaving before just after the previous token.
      if (before.source[before.offset - 1] !== ")") return false;
      if (after.source[skipSqliteTrivia(after.source, after.offset)] === "(") return true;
      if (word === "FILTER") return false;
    }
    const name = yield* Effect.result(followingName.decode(after));
    if (Result.isFailure(name)) return false;
    return word === "OVER" || Result.isSuccess(yield* Effect.result(as.decode(name.success.next)));
  });

export const windowKeyword = (word: "FILTER" | "OVER" | "WINDOW"): Codec<void> => {
  const token = keyword(word);
  return make<void>({
    decode: (cursor) =>
      Effect.gen(function* () {
        const result = yield* token.decode(cursor);
        if (yield* startsWindowSyntax(word, cursor, result.next)) return result;
        return yield* Effect.fail(parseError(cursor, word + " clause"));
      }),
    encode: token.encode,
  });
};
