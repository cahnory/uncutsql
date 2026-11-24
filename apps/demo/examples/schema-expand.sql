-- Append a nullable column with the first migration planner.
create table users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) > 0),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email TEXT
);

create table posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

create view active_users as
  select id, name as user_name from users where status = 'active';
