/**
 * One --apply at a time. Neon's HTTPS driver has no session to hold an advisory lock, so the lock is a row: a small
 * counter row (meal_rate_limits, keyed "lock:roster-import", dated far ahead so the hourly clean-up never removes it)
 * whose count is the minute the run took it. Taking it is one atomic upsert that only succeeds when the row is new or
 * older than STALE_MINUTES (a run that died). Released at the end, whatever happened.
 */
import { and, eq, sql } from "drizzle-orm";
import { mealRateLimits } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

const KEY = "lock:roster-import";
// Far ahead: the clean-ups delete only rows dated in the past.
const WHEN = new Date("2999-01-01T00:00:00Z");
export const STALE_MINUTES = 15;

export class ImportBusy extends Error {
  constructor() {
    super(`Another roster import started in the last ${STALE_MINUTES} minutes and has not finished. Nothing was written.`);
    this.name = "ImportBusy";
  }
}

const minuteOf = (now: Date) => Math.floor(now.getTime() / 60_000);

/** Take the lock or throw ImportBusy. Returns the stamp to release it with. */
export async function takeImportLock(db: Db, now: Date): Promise<number> {
  const stamp = minuteOf(now);
  const [row] = await db
    .insert(mealRateLimits)
    .values({ key: KEY, windowStart: WHEN, count: stamp })
    .onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: stamp }, setWhere: sql`${mealRateLimits.count} <= ${stamp - STALE_MINUTES}` })
    .returning({ count: mealRateLimits.count });
  if (!row) throw new ImportBusy();
  return stamp;
}

export async function releaseImportLock(db: Db, stamp: number): Promise<void> {
  await db.delete(mealRateLimits).where(and(eq(mealRateLimits.key, KEY), eq(mealRateLimits.windowStart, WHEN), eq(mealRateLimits.count, stamp)));
}
