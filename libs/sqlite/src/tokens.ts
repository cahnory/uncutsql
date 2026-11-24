// Lexical exports retained for callers of the initial foundation.
export { skipSqliteTrivia, trivia } from "./operators/trivia.ts";
export { lexeme } from "./operators/lexeme.ts";
export { keyword } from "./operators/keyword.ts";
export { punctuation } from "./operators/punctuation.ts";
export { identifier } from "./codecs/identifier.ts";
export { stringValue } from "./codecs/string-literal.ts";
export { columnType, columnTypes } from "./codecs/type-name.ts";
export type { ColumnType } from "./codecs/type-name.ts";
