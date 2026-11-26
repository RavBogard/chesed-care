/**
 * Retention. Thirty days after a page ended:
 *  - every sign-up loses its note, what was being brought and the family's thanks.
 *    The helper's name and email are kept, with no timer (Daniel, 2026-11-25: "Keep
 *    everything"), so the rabbis and the Mitzvah Corps lead can reach them again;
 *  - the page loses where and what: the address, drop-off instructions and window,
 *    allergies, dietary needs, who is eating, the note, delivery places, gift cards and their email;
 *  - the public and family tokens and their hashes are blanked, so both links stop
 *    resolving (until then they still answer: see ./public.ts and ./family.ts);
 *  - the emails blocked from the page are deleted.
 * Run by the daily job; there is no actor.
 */
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { mealPageBlocks, mealPages, mealSignups, mealSlots } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

export const RETENTION_DAYS = 30;

export async function purgeMealData(db: Db, now: Date = new Date()): Promise<{ pages: number; signups: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const isDue = and(eq(mealPages.status, "ended"), lte(mealPages.endedAt, cutoff));
  const ended = db.select({ id: mealPages.id }).from(mealPages).where(isDue);
  const slots = db.select({ id: mealSlots.id }).from(mealSlots).where(inArray(mealSlots.pageId, ended));
  const due = and(inArray(mealSignups.slotId, slots), isNull(mealSignups.purgedAt));
  const words = { note: null, bringing: null, thanksText: null, purgedAt: now };
  return db.transaction(async (tx) => {
    const kept = await tx.update(mealSignups).set(words).where(due).returning({ id: mealSignups.id });
    // The blocks go, but a blocked helper is still never offered for asking again: their tick is turned off first.
    const blocked = sql<boolean>`exists (select 1 from ${mealPageBlocks} inner join ${mealSlots} on ${mealSlots.pageId} = ${mealPageBlocks.pageId} where ${mealSlots.id} = ${mealSignups.slotId} and ${mealPageBlocks.email} = ${mealSignups.email})`;
    await tx.update(mealSignups).set({ mayContactAgain: false }).where(and(inArray(mealSignups.slotId, slots), eq(mealSignups.mayContactAgain, true), blocked));
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
    return { pages: pages.length, signups: kept.length };
  });
}
