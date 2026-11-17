import type { Effect } from "effect";
import { diffDatabases, type SchemaDiffError } from "../src/index.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<A extends true> = A;
type _Errors = Assert<Equal<Effect.Error<ReturnType<typeof diffDatabases>>, SchemaDiffError>>;
type _Services = Assert<Equal<Effect.Services<ReturnType<typeof diffDatabases>>, never>>;
