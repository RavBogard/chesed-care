/**
 * The abuse limits of the public (no account) meal functions: a counter per key and
 * clock hour in Postgres. One upsert per attempt; old windows are deleted when a new
 * one opens, so the table stays a few rows. No third-party service.
 */
import { createHash } from "node:crypto";
import { and, eq, like, lt, not, sql } from "drizzle-orm";
import { mealRateLimits } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { clientMetaInput } from "./input";

const HOUR = 3_600_000;

/** Attempts per clock hour. Every attempt counts, successful or not. */
export const LIMITS = {
  /** Sign-up attempts from one client. */
  signupPerClient: 20,
  /** Sign-ups that SUCCEED on one page, from everyone. Failed attempts never count here, so nobody can lock a family's page with junk. */
  signupPerPage: 40,
  /** Changes and cancellations through manage links, from one client. */
  managePerClient: 30,
  /** Changes through family links, from one client. */
  familyPerClient: 40,
} as const;

/** A form submitted faster than this was not filled in by a person. */
export const MIN_FILL_MS = 2_000;

/** Count one attempt against `key`; false once the hour's ceiling is passed. */
export async function withinLimit(db: Db, key: string, limit: number, now: Date): Promise<boolean> {
  const windowStart = windowOf(now);
  const [row] = await db
    .insert(mealRateLimits)
    .values({ key, windowStart })
    .onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: sql`${mealRateLimits.count} + 1` } })
    .returning({ count: mealRateLimits.count });
  // Day counters ("day:" keys) live longer than an hour and are cleaned by withinDailyLimit.
  if (row.count === 1) await db.delete(mealRateLimits).where(and(lt(mealRateLimits.windowStart, new Date(windowStart.getTime() - HOUR)), not(like(mealRateLimits.key, "day:%"))));
  return row.count <= limit;
}

const DAY = 24 * HOUR;

/** Like withinLimit, per UTC day. `key` must start with "day:". */
export async function withinDailyLimit(db: Db, key: string, limit: number, now: Date): Promise<boolean> {
  if (!key.startsWith("day:")) throw new Error("daily keys start with day:");
  const windowStart = new Date(Math.floor(now.getTime() / DAY) * DAY);
  const [row] = await db
    .insert(mealRateLimits)
    .values({ key, windowStart })
    .onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: sql`${mealRateLimits.count} + 1` } })
    .returning({ count: mealRateLimits.count });
  if (row.count === 1) await db.delete(mealRateLimits).where(and(like(mealRateLimits.key, "day:%"), lt(mealRateLimits.windowStart, new Date(windowStart.getTime() - DAY))));
  return row.count <= limit;
}

const windowOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR);

/** Count `n` at once against `key` this hour (a claim that takes several dates counts as that many). Returns the new total. */
export async function addToLimit(db: Db, key: string, n: number, now: Date): Promise<number> {
  const windowStart = windowOf(now);
  const [row] = await db
    .insert(mealRateLimits)
    .values({ key, windowStart, count: n })
    .onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: sql`${mealRateLimits.count} + ${n}` } })
    .returning({ count: mealRateLimits.count });
  return row.count;
}

/** Whether the day counter `key` (must start with "day:") has reached its ceiling today. Reads only. */
export async function atDailyLimit(db: Db, key: string, limit: number, now: Date): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / DAY) * DAY);
  const [row] = await db.select({ count: mealRateLimits.count }).from(mealRateLimits).where(and(eq(mealRateLimits.key, key), eq(mealRateLimits.windowStart, windowStart))).limit(1);
  return (row?.count ?? 0) >= limit;
}

/** What `key` has counted this hour. Reads only. */
export async function countOf(db: Db, key: string, now: Date): Promise<number> {
  const [row] = await db.select({ count: mealRateLimits.count }).from(mealRateLimits).where(and(eq(mealRateLimits.key, key), eq(mealRateLimits.windowStart, windowOf(now)))).limit(1);
  return row?.count ?? 0;
}

/** Whether `key` has already reached its ceiling this hour. Reads only: nothing is counted. */
export async function atLimit(db: Db, key: string, limit: number, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ count: mealRateLimits.count })
    .from(mealRateLimits)
    .where(and(eq(mealRateLimits.key, key), eq(mealRateLimits.windowStart, windowOf(now))))
    .limit(1);
  return (row?.count ?? 0) >= limit;
}

export type Client = { hash: string; bot: boolean };

/**
 * The client of a public request, or null when the route passed nothing usable.
 * The address is never stored: only a hash that changes every day, in rows that
 * live two hours. `bot`: the honeypot was filled, or the form came back too fast.
 */
export function readClient(meta: unknown, now: Date, timed: boolean): Client | null {
  const parsed = clientMetaInput.safeParse(meta);
  if (!parsed.success) return null;
  const { clientKey, honeypot, elapsedMs } = parsed.data;
  const hash = createHash("sha256").update(`${now.toISOString().slice(0, 10)}:${clientKey}`).digest("base64url").slice(0, 32);
  const tooFast = timed && !(typeof elapsedMs === "number" && elapsedMs >= MIN_FILL_MS);
  return { hash, bot: !!honeypot || tooFast };
}
