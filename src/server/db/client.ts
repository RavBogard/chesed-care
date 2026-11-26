import "server-only";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { installDatabaseErrorGuard } from "./errors";
import * as schema from "./index";
import type { Db } from "./types";

// Every query error leaves the database layer with a static message (see ./errors).
installDatabaseErrorGuard();

let cached: { db: Db; pool: Pool } | null = null;

/**
 * The runtime database, created on first use (never at import or build time).
 * Throws when DATABASE_URL is not set; callers that must not fail (health) catch it.
 */
export function getDb(): Db {
  if (cached) return cached.db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const pool = new Pool({ connectionString: url, max: 4 });
  cached = { db: drizzle(pool, { schema, logger: false }) as unknown as Db, pool };
  return cached.db;
}

export function isDatabaseConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
