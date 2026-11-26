import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./index";

/** Any drizzle Postgres database over this schema: Neon at runtime, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
