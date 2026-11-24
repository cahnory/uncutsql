import { Effect } from "effect";
import {
  type Codec,
  type SourceNode,
  document,
  make,
  parseError,
  read,
  repeat,
  followedBy,
  optional,
} from "@uncutsql/codec";
import {
  createTableStatementBodyGrammar,
  type CreateTableStatement,
} from "./codecs/create-table-statement.ts";
import { createIndexBodyGrammar, type CreateIndex } from "./codecs/create-index.ts";
import { createTriggerBodyGrammar, type CreateTrigger } from "./codecs/create-trigger.ts";
import { createViewBodyGrammar, type CreateView } from "./codecs/create-view.ts";
import { keyword } from "./operators/keyword.ts";
import { keywordChoice } from "./operators/keyword-choice.ts";
import { terminator } from "./operators/terminator.ts";
import { trivia } from "./operators/trivia.ts";

/** Supported schema statements, in source order. Extend this union with further DDL. */
export type Statement = CreateTableStatement | CreateIndex | CreateView | CreateTrigger;

const statementBody: Codec<Statement> = make<Statement>({
  decode: (cursor) =>
    Effect.gen(function* () {
      const start = yield* keyword("CREATE").decode(cursor);
      const modifier = yield* optional(keywordChoice(["UNIQUE", "TEMP", "TEMPORARY"])).decode(
        start.next,
      );
      const kind = yield* keywordChoice(["TABLE", "INDEX", "VIEW", "TRIGGER"]).decode(
        modifier.next,
      );
      if (kind.value === "TRIGGER") return yield* createTriggerBodyGrammar.decode(cursor);
      if (kind.value === "VIEW") return yield* createViewBodyGrammar.decode(cursor);
      return yield* kind.value === "INDEX"
        ? createIndexBodyGrammar.decode(cursor)
        : createTableStatementBodyGrammar.decode(cursor);
    }),
  encode: (value) =>
    value._tag === "CreateIndex"
      ? createIndexBodyGrammar.encode(value)
      : value._tag === "CreateTrigger"
        ? createTriggerBodyGrammar.encode(value)
        : value._tag === "CreateView"
          ? createViewBodyGrammar.encode(value)
          : createTableStatementBodyGrammar.encode(value),
});

const statementList = repeat(followedBy(statementBody, terminator), { join: "\n" });

export const schemaGrammar: Codec<readonly Statement[]> = make<readonly Statement[]>({
  decode: (cursor) =>
    Effect.gen(function* () {
      let next = (yield* trivia.decode(cursor)).next;
      const statements: Statement[] = [];
      const nodes: SourceNode[] = [];
      while (next.offset < next.source.length) {
        // SQLite permits empty statements and a final statement without a semicolon.
        if (next.source[next.offset] === ";") {
          next = (yield* trivia.decode({ ...next, offset: next.offset + 1 })).next;
          continue;
        }
        const start = next.offset;
        const statement = yield* statementBody.decode(next);
        next = (yield* trivia.decode(statement.next)).next;
        statements.push(statement.value);
        if (next.offset < next.source.length) {
          if (next.source[next.offset] !== ";") {
            return yield* Effect.fail(parseError(next, '";" between statements', true));
          }
          next = { ...next, offset: next.offset + 1 };
        }
        nodes.push({
          kind: statement.value._tag,
          start,
          end: next.offset,
          children: statement.nodes,
        });
        next = (yield* trivia.decode(next)).next;
      }
      return read(statements, next, nodes);
    }),
  encode: statementList.encode,
});

export const schema = document(schemaGrammar, trivia);
