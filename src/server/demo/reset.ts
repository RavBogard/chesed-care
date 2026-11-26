/**
 * Putting the demo back to its starting story: once at the start of each day (the first
 * request of the day does it) and whenever a visitor presses "Start over".
 *
 * It empties every table, so it is fenced twice. It runs only in a demo build, and it
 * refuses a database that holds any account that is not a demo account: pointed at a real
 * congregation's database by mistake, it throws and changes nothing.
 */
import { and, eq, sql } from "drizzle-orm";
import { DEMO_EMAIL_DOMAIN, isDemo } from "@/lib/demo";
import { journeyTemplates, sfDayCache, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { DEFAULT_TEMPLATES, JOURNEY_KEYS } from "@/server/journeys/templates";
import { chicagoToday } from "@/server/lifecycle/window";
import { demoSalesforce } from "./salesforce";
import { insertDemoTeam, seedDemoStory } from "./seed";

export class NotADemoDatabase extends Error {
  constructor() {
    super("This database holds accounts that are not demo accounts");
    this.name = "NotADemoDatabase";
  }
}

const MARK = "demo:seeded";
/** An arbitrary number: the lock two resets wait on, so they cannot both empty the tables. */
const LOCK = 7_231_126;

/** When today's story was written, or null when it has not been. */
async function seededAt(db: Db, day: string): Promise<Date | null> {
  const [row] = await db.select({ data: sfDayCache.data }).from(sfDayCache).where(and(eq(sfDayCache.key, MARK), eq(sfDayCache.day, day))).limit(1);
  if (!row) return null;
  const at = new Date(String((row.data as { at?: unknown } | null)?.at));
  return Number.isNaN(at.getTime()) ? new Date(0) : at;
}
const seededOn = async (db: Db, day: string) => (await seededAt(db, day)) !== null;

/** "Start over" does nothing when the story was written this recently: a double press, or someone leaning on the button. */
export const START_OVER_GAP_MS = 30_000;

/** Throws unless every account in the database is a demo account (an empty database passes). */
export async function assertDemoDatabase(db: Db): Promise<void> {
  if (!isDemo()) throw new NotADemoDatabase();
  const [other] = await db.select({ id: users.id }).from(users).where(sql`${users.email} not like ${`%${DEMO_EMAIL_DOMAIN}`}`).limit(1);
  if (other) throw new NotADemoDatabase();
}

/**
 * Empty the database and write the starting story. `onlyIfStale` skips the work when today's
 * story is already there (decided under the lock, so two first visitors make one story).
 */
export async function resetDemo(db: Db, now: Date = new Date(), opts: { onlyIfStale?: boolean; minGapMs?: number } = {}): Promise<{ reset: boolean; failed: string[] }> {
  const today = chicagoToday(now);
  const team = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    await assertDemoDatabase(tx);
    const last = await seededAt(tx, today);
    if (last && (opts.onlyIfStale || now.getTime() - last.getTime() < (opts.minGapMs ?? 0))) return null;
    // Both drivers (Neon at run time, PGlite in tests) answer with `rows`.
    const tables = (await tx.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { rows: { tablename: string }[] };
    const names = tables.rows.map((r) => `"${r.tablename.replace(/"/g, "")}"`);
    if (names.length > 0) await tx.execute(sql.raw(`truncate ${names.join(", ")} restart identity cascade`));
    await tx.insert(journeyTemplates).values(JOURNEY_KEYS.map((key) => ({ key, name: DEFAULT_TEMPLATES[key].name, steps: DEFAULT_TEMPLATES[key].steps })));
    await tx.insert(sfDayCache).values({ key: MARK, day: today, data: { at: now.toISOString() } });
    return insertDemoTeam(tx);
  });
  if (!team) return { reset: false, failed: [] };
  // Outside the lock: the accounts exist already, so a visitor arriving now gets in and sees the story fill.
  const failed = await seedDemoStory(db, demoSalesforce(() => now), team, now);
  return { reset: true, failed };
}

/** The first request of each day puts the story back. One indexed read on every other request. */
export async function ensureDemoFresh(db: Db, now: Date = new Date()): Promise<void> {
  if (await seededOn(db, chicagoToday(now))) return;
  await resetDemo(db, now, { onlyIfStale: true });
}
