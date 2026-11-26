/**
 * What sendEmail must do for an address that belongs to someone brought in from the old Mitzvah Corps spreadsheet.
 *
 *  - Held (imported, not yet asked): mail the roster starts (an ask, a welcome, anything new) is held. Mail the person
 *    asked for themselves, by signing up for a meal or a task (the confirmation and the day-before reminder), goes
 *    through. Mail to the app's own accounts (the morning summary) is never affected.
 *  - Once the owner has turned their email on, the first email of any kind carries one sentence saying what this is
 *    and their stop link (intro_pending), and the mark is then cleared.
 */
import { and, eq, or } from "drizzle-orm";
import { corpsMembers } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

/** Kinds sent to the app's own signed-in accounts. */
export const ACCOUNT_KINDS: readonly string[] = ["morning_summary"];
/** Kinds a person asked for by signing up themselves: never held. */
export const SELF_REQUESTED_KINDS: readonly string[] = ["meal_signup", "volunteer_signup", "reminder_meal", "reminder_help"];

export type Gate = { held: true } | { held: false; introFor: string | null };

export async function rosterGate(db: Db, to: string, kind: string): Promise<Gate> {
  if (ACCOUNT_KINDS.includes(kind)) return { held: false, introFor: null };
  const [m] = await db
    .select({ id: corpsMembers.id, held: corpsMembers.emailsHeld, intro: corpsMembers.introPending })
    .from(corpsMembers)
    .where(and(eq(corpsMembers.emailKey, to.toLowerCase()), or(eq(corpsMembers.emailsHeld, true), eq(corpsMembers.introPending, true))))
    .limit(1);
  if (!m) return { held: false, introFor: null };
  if (m.held) return SELF_REQUESTED_KINDS.includes(kind) ? { held: false, introFor: null } : { held: true };
  return { held: false, introFor: m.intro ? m.id : null };
}

/**
 * Take the intro for this email, atomically: of two emails sent at the same moment only one gets `true`, and so only
 * one carries the sentence. The other is sent without it.
 */
export async function claimIntro(db: Db, memberId: string): Promise<boolean> {
  const taken = await db
    .update(corpsMembers)
    .set({ introPending: false })
    .where(and(eq(corpsMembers.id, memberId), eq(corpsMembers.introPending, true)))
    .returning({ id: corpsMembers.id });
  return taken.length > 0;
}

/** The email that took the intro was not sent: the next one carries it instead. */
export async function giveBackIntro(db: Db, memberId: string): Promise<void> {
  await db.update(corpsMembers).set({ introPending: true }).where(eq(corpsMembers.id, memberId));
}
