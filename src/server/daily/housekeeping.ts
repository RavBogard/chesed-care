/**
 * Small daily tidying, counts only: capture tokens nobody has used for 180 days are
 * revoked; rate-limit counters past their window are deleted; set-aside suggestions are
 * dropped. (A decided proposal keeps its words, and a sender's name and email are kept:
 * Daniel, 2026-11-25.)
 */
import { and, isNull, like, lt, lte, not, or, sql } from "drizzle-orm";
import { captureTokens, mealRateLimits, suggestionDismissals } from "@/server/db/schema";
import { DISMISS_KEEP_DAYS } from "@/server/care/suggestions";
import type { Db } from "@/server/db/types";
import { DAY_MS, HOUR_MS } from "@/server/lifecycle/window";

export const TOKEN_IDLE_DAYS = 180;

export async function revokeIdleCaptureTokens(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - TOKEN_IDLE_DAYS * DAY_MS);
  const revoked = await db
    .update(captureTokens)
    .set({ revokedAt: now })
    .where(and(isNull(captureTokens.revokedAt), lte(sql`coalesce(${captureTokens.lastUsedAt}, ${captureTokens.createdAt})`, cutoff)))
    .returning({ id: captureTokens.id });
  return revoked.length;
}

/** Hourly counters live two hours, daily ones ("day:" keys) two days: the same windows the counters themselves prune. */
export async function pruneRateLimits(db: Db, now: Date): Promise<number> {
  const hourly = and(not(like(mealRateLimits.key, "day:%")), lt(mealRateLimits.windowStart, new Date(now.getTime() - 2 * HOUR_MS)));
  const daily = and(like(mealRateLimits.key, "day:%"), lt(mealRateLimits.windowStart, new Date(now.getTime() - 2 * DAY_MS)));
  const gone = await db
    .delete(mealRateLimits)
    .where(or(hourly, daily))
    .returning({ key: mealRateLimits.key });
  return gone.length;
}

/** Set-aside suggestions older than 60 days (they only matter for 30). Counts only. */
export async function purgeOldDismissals(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(suggestionDismissals)
    .where(lt(suggestionDismissals.dismissedAt, new Date(now.getTime() - DISMISS_KEEP_DAYS * DAY_MS)))
    .returning({ id: suggestionDismissals.subjectId });
  return gone.length;
}
