-- Proposed changes to compare against schema.sql.
create table users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) > 0),
  email TEXT UNIQUE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

create table posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) > 0),
  created_at TEXT DEFAULT (datetime('now'))
);

create view active_users as
  select id, name as user_name from users where status = 'active';

create trigger deactivate_user instead of delete on active_users begin
  update users set status = 'disabled' where id = OLD.id;
end;
