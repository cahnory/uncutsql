import { Effect } from "effect";
import {
  type Codec, type Cursor, EncodeError, alternatives, located, make, parseError, read,
} from "../codec/index.ts";

const identifierStart = /[A-Za-z_\u0080-\uffff]/;
const identifierPart = /[A-Za-z_0-9$\u0080-\uffff]/;

// SQLite's published keyword set: https://www.sqlite.org/lang_keywords.html
// This initial grammar deliberately requires quoting keywords used as identifiers.
const keywords = new Set(`ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH
AUTOINCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT
CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT
DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE
EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP
GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO
IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL
NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE
RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK
ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION
UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT`.split(/\s+/));

export const trivia: Codec<void> = make<void>({
  decode: (cursor) => Effect.sync(() => {
    const { source } = cursor;
    let offset = cursor.offset;
    while (offset < source.length) {
      if (/[\t\n\v\f\r ]/.test(source[offset]!)) {
        offset++;
      } else if (source.startsWith("--", offset)) {
        const end = source.indexOf("\n", offset + 2);
        offset = end < 0 ? source.length : end + 1;
      } else if (source.startsWith("/*", offset)) {
        const end = source.indexOf("*/", offset + 2);
        offset = end < 0 ? source.length : end + 2;
      } else break;
    }
    return read(undefined, { source, offset });
  }),
  encode: () => Effect.succeed(""),
});

/** Skip leading trivia outside the located codec, keeping spans on actual tokens. */
export const lexeme = <A, E, R>(codec: Codec<A, E, R>): Codec<A, E, R> => make({
  decode: (cursor) => Effect.flatMap(trivia.decode(cursor), (result) => codec.decode(result.next)),
  encode: codec.encode,
});

export const keyword = (text: string): Codec<void> => {
  const canonical = text.toUpperCase();
  if (!/^[A-Z_]+$/.test(canonical)) throw new TypeError("keyword requires one word");
  return lexeme(make<void>({
    decode: (cursor) => {
      const end = cursor.offset + canonical.length;
      const matches = cursor.source.slice(cursor.offset, end).toUpperCase() === canonical;
      const boundary = !identifierPart.test(cursor.source[end] ?? "");
      return matches && boundary
        ? Effect.succeed(read(undefined, { ...cursor, offset: end }))
        : Effect.fail(parseError(cursor, canonical));
    },
    encode: () => Effect.succeed(canonical),
  }));
};

export const punctuation = (text: string, printed = text): Codec<void> => lexeme(make<void>({
  decode: (cursor) => cursor.source.startsWith(text, cursor.offset)
    ? Effect.succeed(read(undefined, { ...cursor, offset: cursor.offset + text.length }))
    : Effect.fail(parseError(cursor, JSON.stringify(text))),
  encode: () => Effect.succeed(printed),
}));

const quoted = (open: string, close = open, doubles = true): Codec<string> => make({
  decode: (cursor) => Effect.suspend(() => {
    if (cursor.source[cursor.offset] !== open) return Effect.fail(parseError(cursor, open));
    let offset = cursor.offset + 1;
    let value = "";
    while (offset < cursor.source.length) {
      const char = cursor.source[offset]!;
      if (char === "\0") return Effect.fail(parseError({ ...cursor, offset }, "text without NUL", true));
      if (char === close) {
        if (doubles && cursor.source[offset + 1] === close) {
          value += close;
          offset += 2;
          continue;
        }
        return Effect.succeed(read(value, { ...cursor, offset: offset + 1 }));
      }
      value += char;
      offset++;
    }
    return Effect.fail(parseError({ ...cursor, offset }, `closing ${close}`, true));
  }),
  encode: (value) => {
    if (typeof value !== "string" || value.includes("\0") || (!doubles && value.includes(close))) {
      return Effect.fail(new EncodeError({ message: `Value cannot be quoted with ${open}${close}` }));
    }
    return Effect.succeed(open + (doubles ? value.replaceAll(close, close + close) : value) + close);
  },
});

const bareIdentifier: Codec<string> = make({
  decode: (cursor) => {
    if (!identifierStart.test(cursor.source[cursor.offset] ?? "")) {
      return Effect.fail(parseError(cursor, "identifier"));
    }
    let end = cursor.offset + 1;
    while (identifierPart.test(cursor.source[end] ?? "")) end++;
    const value = cursor.source.slice(cursor.offset, end);
    return keywords.has(value.toUpperCase())
      ? Effect.fail(parseError(cursor, "quoted identifier (reserved keyword)"))
      : Effect.succeed(read(value, { ...cursor, offset: end }));
  },
  encode: (value) => /^[A-Za-z_\u0080-\uffff][A-Za-z_0-9$\u0080-\uffff]*$/.test(value) && !keywords.has(value.toUpperCase())
    ? Effect.succeed(value)
    : Effect.fail(new EncodeError({ message: "Invalid bare identifier" })),
});

/** Always emit double quotes, including for bare identifiers accepted during parsing. */
export const identifier = lexeme(located("Identifier", alternatives(
  quoted('"'), quoted("`"), quoted("[", "]", false), bareIdentifier,
)));

export const stringValue = lexeme(located("StringLiteral", quoted("'")));

export const columnTypes = ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"] as const;
export type ColumnType = typeof columnTypes[number];

export const columnType: Codec<ColumnType> = lexeme(located("TypeName", make({
  decode: (cursor: Cursor) => {
    let end = cursor.offset;
    while (identifierPart.test(cursor.source[end] ?? "")) end++;
    const value = cursor.source.slice(cursor.offset, end).toUpperCase();
    return columnTypes.includes(value as ColumnType)
      ? Effect.succeed(read(value as ColumnType, { ...cursor, offset: end }))
      : Effect.fail(parseError(cursor, columnTypes));
  },
  encode: (value: ColumnType) => columnTypes.includes(value)
    ? Effect.succeed(value)
    : Effect.fail(new EncodeError({ message: `Unsupported column type: ${value}` })),
})));
