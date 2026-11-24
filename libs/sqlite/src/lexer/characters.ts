export const identifierStart = /[A-Za-z_\u0080-\uffff]/;
export const identifierPart = /[A-Za-z_0-9$\u0080-\uffff]/;

// SQLite keyword comparisons fold only ASCII letters.
export const uppercaseAscii = (text: string) =>
  text.replace(/[a-z]+/g, (word) => word.toUpperCase());
