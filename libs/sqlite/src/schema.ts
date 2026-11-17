import { Effect } from "effect";
import {
  type Codec,
  type SourceNode,
  document,
  make,
  parseError,
  read,
  repeat,
} from "@uncutsql/codec";
import {
  createTableBodyGrammar,
  createTableGrammar,
  type CreateTable,
} from "./codecs/create-table-statement.ts";
import { trivia } from "./operators/trivia.ts";

/** Supported schema statements, in source order. Extend this union with further DDL. */
export type Statement = CreateTable;

const statementList = repeat(createTableGrammar, { join: "\n" });

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
        const statement = yield* createTableBodyGrammar.decode(next);
        next = (yield* trivia.decode(statement.next)).next;
        statements.push(statement.value);
        if (next.offset < next.source.length) {
          if (next.source[next.offset] !== ";") {
            return yield* Effect.fail(parseError(next, '";" between statements', true));
          }
          next = { ...next, offset: next.offset + 1 };
        }
        nodes.push({ kind: "CreateTable", start, end: next.offset, children: statement.nodes });
        next = (yield* trivia.decode(next)).next;
      }
      return read(statements, next, nodes);
    }),
  encode: statementList.encode,
});

export const schema = document(schemaGrammar, trivia);
