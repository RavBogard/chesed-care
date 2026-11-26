/**
 * Retention for volunteer tasks. Thirty days after a task's date (the day counts as day zero):
 *  - every claim loses its note, its "done" note and its personal link, so the link stops resolving.
 *    The volunteer's name and contact are kept, with no timer (Daniel, 2026-11-25: "Keep everything"),
 *    so the rabbis and the Mitzvah Corps lead can reach them again;
 *  - the task loses where, the contact line and its public link;
 *  - the blocks on it are deleted;
 *  - a shiva sheet whose every evening is that old loses its "bringing" lines and its link.
 * Claims made together by "I can do this every time" keep one personal link until the last of the set's dates has passed.
 * A task cancelled thirty days ago loses where and the contact line even before its date.
 * Run by the daily job; there is no actor. Counts only are recorded (job_runs).
 */
import { and, eq, inArray, isNotNull, isNull, lte, not, notExists, or, sql } from "drizzle-orm";
import { volunteerBringing, volunteerClaims, volunteerGroups, volunteerTaskBlocks, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";

export const VOLUNTEER_RETENTION_DAYS = 30;

export async function purgeVolunteerData(db: Db, now: Date = new Date()): Promise<{ claims: number; tasks: number; bringing: number }> {
  const cutoff = addDays(chicagoToday(now), -VOLUNTEER_RETENTION_DAYS);
  const cancelledBefore = new Date(now.getTime() - VOLUNTEER_RETENTION_DAYS * 86_400_000);
  const aged = lte(volunteerTasks.taskDate, cutoff);
  const oldTasks = db.select({ id: volunteerTasks.id }).from(volunteerTasks).where(aged);
  // The personal link's token of an "every time" set lives until the set's last date has passed.
  const setStillRunning = sql<boolean>`exists (select 1 from volunteer_claims c2 inner join volunteer_tasks t2 on t2.id = c2.task_id where c2.claim_set_id = ${volunteerClaims.claimSetId} and t2.task_date >= ${addDays(chicagoToday(now), -1)})`;
  const due = and(inArray(volunteerClaims.taskId, oldTasks), isNull(volunteerClaims.purgedAt));
  const words = { note: null, doneNote: null };
  return db.transaction(async (tx) => {
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
    // The blocks go, but a blocked volunteer is still never offered for asking again: their tick is turned off first.
    const blocked = sql<boolean>`exists (select 1 from ${volunteerTaskBlocks} where ${volunteerTaskBlocks.taskId} = ${volunteerClaims.taskId} and ${volunteerTaskBlocks.contactKey} = ${volunteerClaims.contactKey})`;
    await tx.update(volunteerClaims).set({ mayAskAgain: false }).where(and(inArray(volunteerClaims.taskId, oldTasks), eq(volunteerClaims.mayAskAgain, true), blocked));
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
    return { claims: new Set([...wordsGone, ...kept].map((r) => r.id)).size, tasks: tasks.length, bringing: bringing.length };
  });
}
