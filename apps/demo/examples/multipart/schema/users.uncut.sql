create table users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) > 0),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);
