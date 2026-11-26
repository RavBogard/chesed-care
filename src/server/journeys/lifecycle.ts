/**
 * What happens to a journey around its steps: a standing check-in's next step, and
 * the end of a journey. Small and free of policy on purpose: the callers (follow-ups,
 * care items, the daily job) have already decided the actor may do what led here.
 */
import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { canHoldRestricted, isValidAssignment } from "@/server/access/policy";
import { careItemJourneys, careItems, followUps, journeyTemplates, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { STANDING_DEFAULT_WEEKS, TEMPLATE_META, isJourneyKey } from "./templates";

/**
 * A standing check-in has one open step at a time: when the last is done (or
 * skipped, which is done without logging a contact), the next is made, `interval`
 * weeks after the day it was done. Nothing is made for an ended journey, a closed
 * item, or a journey that still has an open step. Returns whether one was made.
 */
export async function ensureNextStandingStep(db: Db, journeyId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    // One at a time per journey: completing a step and the daily safety net must never both make one.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${journeyId}))`);
    return nextStandingStep(tx, journeyId, now);
  });
}

async function nextStandingStep(db: Db, journeyId: string, now: Date): Promise<boolean> {
  const [run] = await db
    .select({ run: careItemJourneys, item: careItems })
    .from(careItemJourneys)
    .innerJoin(careItems, eq(careItems.id, careItemJourneys.careItemId))
    .where(and(eq(careItemJourneys.id, journeyId), isNull(careItemJourneys.endedAt), ne(careItems.status, "closed")))
    .limit(1);
  if (!run || !isJourneyKey(run.run.templateKey) || !TEMPLATE_META[run.run.templateKey].standing) return false;
  const open = await db
    .select({ id: followUps.id })
    .from(followUps)
    .where(and(eq(followUps.journeyId, journeyId), isNull(followUps.doneAt)))
    .limit(1);
  if (open.length > 0) return false;
  const [last] = await db
    .select({ title: followUps.title, doneAt: followUps.doneAt })
    .from(followUps)
    .where(and(eq(followUps.journeyId, journeyId), isNotNull(followUps.doneAt)))
    .orderBy(desc(followUps.doneAt))
    .limit(1);
  const today = chicagoToday(now);
  const from = last?.doneAt ? chicagoToday(last.doneAt) : today;
  const weeks = run.run.intervalWeeks ?? STANDING_DEFAULT_WEEKS;
  const due = addDays(from, 7 * weeks);
  // The title as it was when the journey began: a later template edit changes only later starts.
  const title = last?.title ?? (await templateTitle(db, run.run.templateKey));
  const { item } = run;
  // The item's holder, while they may still hold it; otherwise nobody, so it shows as unassigned work for the clergy.
  const [holder] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, item.ownerUserId)).limit(1);
  const assignable = !!holder && isValidAssignment(holder, item.visibility) && (!item.restricted || canHoldRestricted(holder));
  await db.insert(followUps).values({
    careItemId: item.id,
    sfContactId: item.sfContactId,
    outsidePersonId: item.outsidePersonId,
    sfAccountId: item.sfAccountId,
    displayName: item.displayName,
    title,
    dueDate: due < today ? today : due,
    ownerUserId: assignable ? item.ownerUserId : null,
    createdBy: run.run.startedBy,
    journeyId,
    createdAt: now,
  });
  return true;
}

/**
 * A standing check-in's step brought back from done: the next one, made when it was
 * done, is removed while still open, so there is never more than one open step.
 * Returns the ids removed, for the caller to audit. Other journeys' steps are all meant to be open at once.
 */
export async function removeLaterStandingSteps(db: Db, journeyId: string, reopenedId: string): Promise<string[]> {
  const [run] = await db.select({ templateKey: careItemJourneys.templateKey }).from(careItemJourneys).where(eq(careItemJourneys.id, journeyId)).limit(1);
  if (!run || !isJourneyKey(run.templateKey) || !TEMPLATE_META[run.templateKey].standing) return [];
  const gone = await db
    .delete(followUps)
    .where(and(eq(followUps.journeyId, journeyId), isNull(followUps.doneAt), ne(followUps.id, reopenedId)))
    .returning({ id: followUps.id });
  return gone.map((g) => g.id);
}

async function templateTitle(db: Db, key: string): Promise<string> {
  const [t] = await db.select({ steps: journeyTemplates.steps }).from(journeyTemplates).where(eq(journeyTemplates.key, key)).limit(1);
  const steps = t?.steps as { title?: unknown }[] | undefined;
  return typeof steps?.[0]?.title === "string" ? steps[0].title : "Be in touch";
}

/** End one journey: its steps still to do are removed, the done ones stay. Returns how many were removed. */
export async function endJourneyRun(db: Db, journeyId: string, endedBy: string, now: Date): Promise<number> {
  await db.update(careItemJourneys).set({ endedAt: now, endedBy }).where(and(eq(careItemJourneys.id, journeyId), isNull(careItemJourneys.endedAt)));
  const removed = await db
    .delete(followUps)
    .where(and(eq(followUps.journeyId, journeyId), isNull(followUps.doneAt)))
    .returning({ id: followUps.id });
  return removed.length;
}

/** Closing a care item ends every journey on it. Returns the ended journeys' ids. */
export async function endJourneysForItem(db: Db, careItemId: string, endedBy: string, now: Date): Promise<string[]> {
  const running = await db
    .select({ id: careItemJourneys.id })
    .from(careItemJourneys)
    .where(and(eq(careItemJourneys.careItemId, careItemId), isNull(careItemJourneys.endedAt)));
  for (const { id } of running) await endJourneyRun(db, id, endedBy, now);
  return running.map((r) => r.id);
}
