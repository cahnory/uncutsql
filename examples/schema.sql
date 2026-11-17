-- A small schema for the check and format commands.
create table users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) > 0),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

create table posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
