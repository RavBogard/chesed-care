/**
 * Retention. Thirty days after a page ended:
 *  - every sign-up loses its note, what was being brought and the family's thanks;
 *  - every helper loses their name and email, except one who ticked "CRC may ask me
 *    to help another family in future" AND was never removed by an organiser or
 *    blocked from the page: those are never kept, opted in or not;
 *  - the page loses where and what: the address, drop-off instructions and window,
 *    allergies, dietary needs, who is eating, the note, delivery places, gift cards and their email;
 *  - the public and family tokens and their hashes are blanked, so both links stop
 *    resolving (until then they still answer: see ./public.ts and ./family.ts);
 *  - the emails blocked from the page are deleted.
 * Run by the daily job; there is no actor.
 */
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { mealPageBlocks, mealPages, mealSignups, mealSlots } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

export const RETENTION_DAYS = 30;

export async function purgeMealData(db: Db, now: Date = new Date()): Promise<{ pages: number; signups: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const isDue = and(eq(mealPages.status, "ended"), lte(mealPages.endedAt, cutoff));
  const ended = db.select({ id: mealPages.id }).from(mealPages).where(isDue);
  const slots = db.select({ id: mealSlots.id }).from(mealSlots).where(inArray(mealSlots.pageId, ended));
  const due = and(inArray(mealSignups.slotId, slots), isNull(mealSignups.purgedAt));
  const blocked = sql<boolean>`exists (select 1 from ${mealPageBlocks} inner join ${mealSlots} on ${mealSlots.pageId} = ${mealPageBlocks.pageId} where ${mealSlots.id} = ${mealSignups.slotId} and ${mealPageBlocks.email} = ${mealSignups.email})`;
  const removed = eq(mealSignups.cancelledBy, "organiser");
  const neverKept = or(eq(mealSignups.mayContactAgain, false), removed, blocked)!;
  const words = { note: null, bringing: null, thanksText: null, purgedAt: now };
  return db.transaction(async (tx) => {
    const forgotten = await tx
      .update(mealSignups)
      .set({ ...words, firstName: null, lastName: null, email: null })
      .where(and(due, neverKept))
      .returning({ id: mealSignups.id });
    const kept = await tx.update(mealSignups).set(words).where(due).returning({ id: mealSignups.id });
    await tx.delete(mealPageBlocks).where(inArray(mealPageBlocks.pageId, ended));
    const pages = await tx
      .update(mealPages)
      .set({
        publicToken: null,
        publicTokenHash: null,
        familyToken: null,
        familyTokenHash: null,
        dropOffAddress: null,
        dropOffInstructions: null,
        dropOffWindow: null,
        allergies: null,
        dietary: [],
        foodFor: null,
        note: null,
        deliveryPlaces: null,
        giftCards: null,
        giftCardEmail: null,
      })
      .where(and(isDue, isNotNull(mealPages.publicTokenHash)))
      .returning({ id: mealPages.id });
    return { pages: pages.length, signups: forgotten.length + kept.length };
  });
}
