// Applies the migration files in src/server/db/migrations. Run explicitly
// (`npm run db:migrate`); the build and the app never run it.
// Uses DATABASE_MIGRATION_URL when set (e.g. a direct, non-pooled Neon URL),
// otherwise DATABASE_URL. Never prints the URL or driver errors (they can carry it).
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const migrationsFolder = fileURLToPath(new URL("../src/server/db/migrations", import.meta.url));

let client;
try {
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("missing");
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("protocol");
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await migrate(drizzle(client, { logger: false }), { migrationsFolder });
  console.log("Database migrations completed");
} catch {
  console.error("Database migration failed; check DATABASE_MIGRATION_URL / DATABASE_URL and database permissions");
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
