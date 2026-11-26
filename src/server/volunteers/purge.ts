/**
 * Retention for volunteer tasks. Thirty days after a task's date (the day counts as day zero):
 *  - every claim loses its note, its "done" note and its personal link, so the link stops
 *    resolving; and its name and contact, unless the volunteer ticked "you may ask me again"
 *    AND was never removed by a poster, never cancelled and not blocked from the task (those are never kept);
 *  - the task loses where, the contact line and its public link;
 *  - the blocks on it are deleted;
 *  - a shiva sheet whose every evening is that old loses its "bringing" lines and its link.
 * Claims made together by "I can do this every time" lose names and contacts like any other, each on its own date plus thirty days; only the set's one personal link lives on, until the last of its dates has passed.
 * Contacts kept for "ask me again" are kept at most 24 months from the task date, then deleted too.
 * A task cancelled thirty days ago loses where and the contact line even before its date.
 * Run by the daily job; there is no actor. Counts only are recorded (job_runs).
 */
import { and, eq, inArray, isNotNull, isNull, lte, not, notExists, or, sql } from "drizzle-orm";
import { volunteerBringing, volunteerClaims, volunteerGroups, volunteerTaskBlocks, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";

export const VOLUNTEER_RETENTION_DAYS = 30;
/** "Ask me again" contacts live this long after the task date. */
export const ASK_AGAIN_MONTHS = 24;

/** `date` minus whole months (a 29 February clamps to the 28th). */
export function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export async function purgeVolunteerData(db: Db, now: Date = new Date()): Promise<{ claims: number; tasks: number; bringing: number; askAgainExpired: number }> {
  const cutoff = addDays(chicagoToday(now), -VOLUNTEER_RETENTION_DAYS);
  const cancelledBefore = new Date(now.getTime() - VOLUNTEER_RETENTION_DAYS * 86_400_000);
  const aged = lte(volunteerTasks.taskDate, cutoff);
  const oldTasks = db.select({ id: volunteerTasks.id }).from(volunteerTasks).where(aged);
  // Names and contacts go per claim, on that claim's own date plus thirty days (given-back and removed claims too). Only the
  // personal link's token of an "every time" set outlives that: it lives until the set's last date has passed.
  const setStillRunning = sql<boolean>`exists (select 1 from volunteer_claims c2 inner join volunteer_tasks t2 on t2.id = c2.task_id where c2.claim_set_id = ${volunteerClaims.claimSetId} and t2.task_date >= ${addDays(chicagoToday(now), -1)})`;
  const due = and(inArray(volunteerClaims.taskId, oldTasks), isNull(volunteerClaims.purgedAt));
  const blocked = sql<boolean>`exists (select 1 from ${volunteerTaskBlocks} where ${volunteerTaskBlocks.taskId} = ${volunteerClaims.taskId} and ${volunteerTaskBlocks.contactKey} = ${volunteerClaims.contactKey})`;
  const removed = eq(volunteerClaims.cancelledBy, "poster");
  const neverKept = or(eq(volunteerClaims.mayAskAgain, false), removed, isNotNull(volunteerClaims.cancelledAt), blocked)!;
  const words = { note: null, doneNote: null };
  return db.transaction(async (tx) => {
    const forgotten = await tx
      .update(volunteerClaims)
      .set({ ...words, firstName: null, lastName: null, contact: null, contactKey: null, personRef: null })
      .where(and(due, neverKept, or(isNotNull(volunteerClaims.contact), isNotNull(volunteerClaims.firstName), isNotNull(volunteerClaims.note))))
      .returning({ id: volunteerClaims.id });
    const wordsGone = await tx
      .update(volunteerClaims)
      .set(words)
      .where(and(due, or(isNotNull(volunteerClaims.note), isNotNull(volunteerClaims.doneNote))))
      .returning({ id: volunteerClaims.id });
    // The personal link dies with the claim, or, for an "every time" set, once the set has no date still to come.
    const kept = await tx
      .update(volunteerClaims)
      .set({ manageTokenHash: null, purgedAt: now, personRef: null })
      .where(and(due, not(setStillRunning)))
      .returning({ id: volunteerClaims.id });
    // Contacts kept for asking again go too once the task is 24 months old.
    const expired = await tx
      .update(volunteerClaims)
      .set({ firstName: null, lastName: null, contact: null, contactKey: null, personRef: null })
      .where(and(isNotNull(volunteerClaims.contact), inArray(volunteerClaims.taskId, db.select({ id: volunteerTasks.id }).from(volunteerTasks).where(lte(volunteerTasks.taskDate, monthsBefore(chicagoToday(now), ASK_AGAIN_MONTHS))))))
      .returning({ id: volunteerClaims.id });
    await tx.delete(volunteerTaskBlocks).where(inArray(volunteerTaskBlocks.taskId, oldTasks));
    const tasks = await tx
      .update(volunteerTasks)
      .set({ place: null, contactLine: null, publicToken: null, publicTokenHash: null })
      .where(and(or(aged, and(eq(volunteerTasks.status, "cancelled"), lte(volunteerTasks.cancelledAt, cancelledBefore)))!, or(isNotNull(volunteerTasks.place), isNotNull(volunteerTasks.contactLine), isNotNull(volunteerTasks.publicTokenHash))))
      .returning({ id: volunteerTasks.id });
    // A sheet is done when none of its evenings is newer than the cutoff.
    const newer = tx.select({ id: volunteerTasks.id }).from(volunteerTasks).where(and(eq(volunteerTasks.groupId, volunteerGroups.id), sql`${volunteerTasks.taskDate} > ${cutoff}`));
    const finished = tx.select({ id: volunteerGroups.id }).from(volunteerGroups).where(notExists(newer));
    const bringing = await tx.delete(volunteerBringing).where(inArray(volunteerBringing.groupId, finished)).returning({ id: volunteerBringing.id });
    await tx.update(volunteerGroups).set({ publicToken: null, publicTokenHash: null }).where(and(notExists(newer), isNotNull(volunteerGroups.publicTokenHash)));
    return { claims: new Set([...forgotten, ...wordsGone, ...kept].map((r) => r.id)).size, tasks: tasks.length, bringing: bringing.length, askAgainExpired: expired.length };
  });
}
