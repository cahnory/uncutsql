# UncutSQL for VS Code

Open a SQLite schema in a trusted local workspace to see parser errors in Problems and declarations in Outline. Press F12 on the table or a column in a `REFERENCES` clause to jump to its declaration. Navigation reads closed files from disk and uses the current text of open files.

## Try the multipart demo

Run these commands from the repository root with VS Code 1.110 or later installed.

```sh
pnpm install
pnpm --filter uncutsql-vscode build
code --new-window --extensionDevelopmentPath="$PWD/apps/vscode" apps/demo/examples/multipart
```

Open `schema/blog/posts.uncut.sql`. In `REFERENCES users(id)`, F12 on `users` opens the table declaration in `schema/users.uncut.sql`. F12 on `id` selects the column.

The extension searches from the SQL file up to its workspace folder for the nearest CLI configuration. A configured schema file is checked individually. A configured directory includes its recursive `*.uncut.sql` files. Without a schema path, a `*.uncut.sql` file is checked on its own. The extension supports the default SQLite dialect and the explicit `@uncutsql/sqlite` adapter. A parser error appears at its UTF-16 offset. Outline and navigation use successfully parsed documents.

## Verification

Run `pnpm --filter uncutsql-vscode check:editor` to exercise the providers in a temporary copy of the demo with an isolated VS Code profile. The command uses `code` on PATH or the executable named by `VSCODE_CLI`.

## Roadmap

Use feedback on foreign key navigation to decide whether to index references. The editor-independent service in `@uncutsql/sqlite/language-service` can also support a future LSP server.
