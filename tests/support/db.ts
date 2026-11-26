import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Actor } from "@/server/access/policy";
import * as schema from "@/server/db/index";
import { users } from "@/server/db/schema";
import { installDatabaseErrorGuard } from "@/server/db/errors";
import type { Db } from "@/server/db/types";

const MIGRATIONS = "src/server/db/migrations";

/**
 * The migrated, empty database as a PGlite dump. Running every migration costs seconds, and
 * most test files ask for a fresh database before each test, so the migrations run once per
 * set of migration files and every later database is loaded from the dump. The dump is kept
 * in the system temp folder under a hash of the migration files, so a changed migration
 * never meets a stale dump.
 */
let template: Promise<Blob> | null = null;

function migratedTemplate(): Promise<Blob> {
  template ??= (async () => {
    const hash = createHash("sha256");
    for (const name of readdirSync(MIGRATIONS).sort()) {
      if (name.endsWith(".sql")) hash.update(name).update(readFileSync(join(MIGRATIONS, name)));
    }
    const file = join(tmpdir(), `crc-care-test-db-${hash.digest("hex").slice(0, 16)}.tar`);
    if (existsSync(file)) return new Blob([readFileSync(file)]);
    const client = new PGlite();
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
    const dump = await client.dumpDataDir("none");
    await client.close();
    // Written under a private name first: another worker may be reading or writing the same dump.
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, Buffer.from(await dump.arrayBuffer()));
    renameSync(partial, file);
    return dump;
  })();
  return template;
}

/** A new, empty database of its own: every migration applied, nothing shared. */
async function freshDb(): Promise<{ client: PGlite; db: Db }> {
  const client = new PGlite({ loadDataDir: await migratedTemplate() });
  if (insideTest) {
    recent.push(client);
    // Closing is not awaited: nothing may still be reading from a database this old.
    while (recent.length > KEEP_OPEN) void recent.shift()?.close().catch(() => undefined);
  }
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

/**
 * Loading a database costs about half a second, and most files ask for one before every test, which was three quarters
 * of the suite's time. So the first database a test asks for is one kept for the whole file and EMPTIED first: every
 * table truncated and the seeded journey templates put back (about 40 ms). The test sees exactly what a new database
 * would hold.
 *
 * Still a database of its own: one asked for outside a test (a beforeAll, shared by the file on purpose), and a second
 * one asked for within the same test. A test that changes the schema (drops a column, renames a table) cannot spoil
 * the next: the shared database's shape is checked before each reuse and it is replaced when it differs or will not answer.
 */
type Shared = { client: PGlite; db: Db; reset: string; shape: string };
let shared: Shared | null = null;
let handedThisTest = false;

// Columns, constraints, triggers and functions: what tests have been seen to change.
const SHAPE = `select concat_ws('|',
  (select count(*)::text || ':' || coalesce(sum(hashtext(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable)), 0)::text from information_schema.columns where table_schema = 'public'),
  (select count(*)::text || ':' || coalesce(sum(hashtext(conname)), 0)::text from pg_constraint where connamespace = 'public'::regnamespace),
  (select count(*)::text || ':' || coalesce(sum(hashtext(tgname)), 0)::text from pg_trigger where not tgisinternal),
  (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace)) as shape`;
const shapeOf = async (client: PGlite) => (await client.query<{ shape: string }>(SHAPE)).rows[0].shape;

async function makeShared(): Promise<Shared> {
  const { client, db } = await freshDb();
  // Not counted among the per-test databases that are closed as newer ones appear.
  const at = recent.indexOf(client);
  if (at >= 0) recent.splice(at, 1);
  const tables = (await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")).rows.map((r) => `"${r.tablename}"`);
  await client.exec("create schema test_seed; create table test_seed.journey_templates as select * from public.journey_templates");
  const reset = `truncate ${tables.join(", ")} restart identity cascade; insert into public.journey_templates select * from test_seed.journey_templates;`;
  return { client, db, reset, shape: await shapeOf(client) };
}

/** An empty in-memory Postgres (PGlite) with the real migrations applied. Never a network database. */
export async function testDb(): Promise<Db> {
  installDatabaseErrorGuard();
  if (!insideTest || handedThisTest) return (await freshDb()).db;
  handedThisTest = true;
  if (shared) {
    try {
      if ((await shapeOf(shared.client)) !== shared.shape) throw new Error("schema changed");
      await shared.client.exec(shared.reset);
      return shared.db;
    } catch {
      void shared.client.close().catch(() => undefined);
      shared = null;
    }
  }
  shared = await makeShared();
  return shared.db;
}

/**
 * Each open database holds about 180 MB, and a file that made one per test once reached
 * 6 GB, which got CI runners killed. So the extra databases made for a single test are
 * closed once a few newer ones exist. One made in a beforeAll is shared by the whole file
 * and is never closed here. The last few stay open because a page render can still be
 * reading from the previous test's database just after that test ends.
 * tests/support/setup.ts says when a test is running.
 */
const KEEP_OPEN = 3;
const recent: PGlite[] = [];
let insideTest = false;

export function markInsideTest(inside: boolean): void {
  insideTest = inside;
  if (inside) handedThisTest = false;
}

export async function addActor(db: Db, email: string, role: Actor["role"], active = true): Promise<Actor> {
  const [row] = await db.insert(users).values({ email, name: email.split("@")[0], role, active }).returning();
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/** The standard team: an owner, two clergy, two caregivers. */
export async function team(db: Db) {
  return {
    owner: await addActor(db, "owner@example.test", "owner"),
    clergy: await addActor(db, "clergy@example.test", "clergy"),
    clergy2: await addActor(db, "clergy2@example.test", "clergy"),
    carer: await addActor(db, "carer@example.test", "caregiver"),
    carer2: await addActor(db, "carer2@example.test", "caregiver"),
  };
}

export const CONTACT = "003000000000001AAA";
export const CONTACT2 = "003000000000002AAA";
export const ACCOUNT = "001000000000001AAA";

/** The roles that only report a need: front office staff, the Mitzvah Corps lead, senior staff. */
export async function reporters(db: Db) {
  return {
    staff: await addActor(db, "staff@example.test", "staff"),
    lead: await addActor(db, "lead@example.test", "lead"),
    senior: await addActor(db, "senior@example.test", "senior_staff"),
  };
}
