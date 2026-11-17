# @uncutsql/cli

The `uncutsql` executable and generic schema/migration workflows. This package has
no dependency on a concrete dialect or database driver. Choose plugins through
`--dialect`, `--driver` or configuration; see the [workspace README](../../README.md).

`pnpm cli --help` runs source in this workspace. Building produces the executable
`dist/index.mjs` and the public API `dist/api.mjs` with declarations. Package exports
and `bin` switch to those built files when packed. `defineConfig` provides typed
configuration for JavaScript/TypeScript config files.

Unit tests use fixture adapters. SQLite end-to-end tests live in `apps/demo`, whose
manifest explicitly declares its selected dialect and driver.
