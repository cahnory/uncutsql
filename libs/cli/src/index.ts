#!/usr/bin/env node
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Result } from "effect";

import { MigrationDecisionError } from "@uncutsql/core";

import { UsageError } from "./config.ts";
import { runCommands } from "./router.ts";

const program = runCommands(process.argv.slice(2)).pipe(Effect.provide(NodeServices.layer));

// Run the selected command once and map failures to process exit codes.
const result = await Effect.runPromise(Effect.result(program));
if (Result.isFailure(result)) {
  const error = result.failure;
  process.stderr.write(`${error.message}\n`);
  if (error instanceof UsageError) {
    process.stderr.write(`\nUsage: ${error.usage ?? "uncutsql --help"}\n`);
  }
  if (error instanceof MigrationDecisionError) {
    process.stderr.write(
      "Use --write-decisions [new-file] to start a review or --merge-decisions [file] to refresh an existing review. No migration was generated.\n",
    );
  }
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
