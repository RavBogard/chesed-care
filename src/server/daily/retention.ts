/**
 * Note retention (Daniel, 2026-11-24): the fact of care is kept; note TEXT is deleted
 * three years after a care item closed, unless the item is marked "keep".
 *
 * For each closed item past the cutoff, in one transaction: the item's own free text
 * (what is going on, where, how we learned), the notes of the contact log entries on
 * it, and its follow-ups' free text are cleared: a lead's one-line outcome, and every
 * follow-up title, which becomes a neutral "Follow-up" (journey steps included: a step's
 * title can be edited into free text). Rows and dates stay. One audit row per item, with
 * ids only. Open, new and
 * paused items are never touched. Run by the daily job, which has no actor: it reads
 * nothing out and returns counts only, so a restricted item is handled like any other
 * without anyone seeing it.
 */
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { agendaEntries, careItems, contactLog, followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { writeSystemAudit } from "@/server/care/audit";

export const RETENTION_YEARS = 3;
/** Items handled per run: a backlog clears over a few mornings rather than in one long run. */
const BATCH = 500;
/** What a hand-typed follow-up's title becomes. */
export const PURGED_TITLE = "Follow-up";

/** After "keep" is switched off, the notes get this many days more, even past their three years. */
export const UNKEEP_GRACE_DAYS = 30;
const DAY = 86_400_000;

/**
 * The same instant `years` earlier, for the purge's cutoff. From 29 February into a year
 * without one it is 28 February, never 1 March: rolling forward would purge a day early.
 */
export function yearsBefore(at: Date, years: number): Date {
  const d = new Date(at.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - years, d.getUTCMonth(), 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(at.getUTCDate(), last));
  return d;
}

/** The first instant the purge can take an item closed at `closedAt`: its cutoff passes it. 29 February closes become due on 1 March. */
function threeYearsOn(closedAt: Date): Date {
  const d = new Date(closedAt.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS);
  return d;
}

/** The day a closed item's notes are due to be deleted, or null when they never will be (open, kept) or already were. */
export function notesDeleteOn(item: { status: string; closedAt: Date | null; keepNotes: boolean; notesPurgedAt: Date | null; notesUnkeptAt?: Date | null }): Date | null {
  if (item.status !== "closed" || !item.closedAt || item.keepNotes || item.notesPurgedAt) return null;
  const due = threeYearsOn(item.closedAt);
  const grace = item.notesUnkeptAt ? new Date(item.notesUnkeptAt.getTime() + UNKEEP_GRACE_DAYS * DAY) : null;
  return grace && grace > due ? grace : due;
}

export async function purgeOldNotes(db: Db, now: Date): Promise<{ items: number; contacts: number; followUps: number }> {
  const cutoff = yearsBefore(now, RETENTION_YEARS);
  const graceCutoff = new Date(now.getTime() - UNKEEP_GRACE_DAYS * DAY);
  const due = await db
    .select({ id: careItems.id })
    .from(careItems)
    .where(dueWhere(cutoff, graceCutoff))
    .limit(BATCH);
  let items = 0;
  let contacts = 0;
  let steps = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      // Checked again inside the transaction: an item reopened or marked keep a moment ago is left alone.
      const [item] = await tx
        .update(careItems)
        .set({ summary: null, location: null, learnedFrom: null, corpsNote: null, notesPurgedAt: now })
        .where(and(eq(careItems.id, id), dueWhere(cutoff, graceCutoff)))
        .returning({ id: careItems.id });
      if (!item) return;
      items++;
      contacts += (await tx.update(contactLog).set({ note: null }).where(eq(contactLog.careItemId, id)).returning({ id: contactLog.id })).length;
      // Every follow-up on the item, journey steps included: a step's title can be edited into free text, and a lead's outcome line is free text.
      steps += (await tx.update(followUps).set({ title: PURGED_TITLE, outcomeNote: null }).where(eq(followUps.careItemId, id)).returning({ id: followUps.id })).length;
      // An agenda entry about the item carries free text too (why, outcome).
      await tx.update(agendaEntries).set({ why: null, outcome: null }).where(eq(agendaEntries.careItemId, id));
      await writeSystemAudit(tx, "care_item.notes_purged", "care_item", id, { careItemId: id });
    });
  }
  // Person-level and free-text agenda entries have no care item to wait for: their words go after 90 days.
  await db
    .update(agendaEntries)
    .set({ why: null, outcome: null })
    .where(and(isNull(agendaEntries.careItemId), lt(agendaEntries.createdAt, new Date(now.getTime() - 90 * DAY))));
  return { items, contacts, followUps: steps };
}

/** Closed three years ago, not kept, not yet cleared, and not within 30 days of "keep" being switched off. */
function dueWhere(cutoff: Date, graceCutoff: Date) {
  return and(
    eq(careItems.status, "closed"),
    lte(careItems.closedAt, cutoff),
    eq(careItems.keepNotes, false),
    isNull(careItems.notesPurgedAt),
    or(isNull(careItems.notesUnkeptAt), lte(careItems.notesUnkeptAt, graceCutoff)),
  );
}
