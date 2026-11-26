import { Argument, Command, Flag } from "effect/cli";

const configFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.withDefault(undefined));

export const root = Command.make("uncutsql").pipe(
  Command.withSharedFlags({
    config: configFlag("config", "Read configuration from this file."),
    dialect: configFlag("dialect", "Load this SQL dialect module."),
    driver: configFlag("driver", "Load this database driver module."),
    migrations: configFlag("migrations", "Directory containing migrations and the schema lock."),
    schema: configFlag("schema", "Read the schema from a file, directory, or stdin (-)."),
  }),
);

export const outputDirectory = Argument.String("output-dir").pipe(
  Argument.withDescription("Override the configured migrations directory."),
  Argument.withDefault(undefined),
);

export const schemaPath = Argument.String("schema-path").pipe(
  Argument.withDescription("Read SQL from a file, directory, or stdin (-)."),
  Argument.withDefault(undefined),
);
