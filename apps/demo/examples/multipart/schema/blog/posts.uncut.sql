create table posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
