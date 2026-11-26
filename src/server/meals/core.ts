/**
 * What the organiser, public and family sides of Mitzvah Meals share: a page's
 * dates with whoever has taken each, coverage, status changes and claiming a date.
 * Nothing here decides access; callers have already checked an actor or a token.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { CONGREGATION_NAME } from "@/lib/brand";
import { DatabaseError } from "@/server/db/errors";
import { mealPages, mealSignups, mealSlots } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { newToken, tokenHash } from "./tokens";

export const CONGREGATION = CONGREGATION_NAME;

export type MealPage = typeof mealPages.$inferSelect;
export type MealSlot = typeof mealSlots.$inferSelect;
export type MealSignup = typeof mealSignups.$inferSelect;
export type MealPageStatus = MealPage["status"];
/** A date with its active sign-up, if any. */
export type SlotRow = { slot: MealSlot; signup: MealSignup | null };

/** Every date of the given pages, earliest first, each with its active (not cancelled) sign-up. */
export async function loadSlots(db: Db, pageIds: string[]): Promise<SlotRow[]> {
  if (pageIds.length === 0) return [];
  return db
    .select({ slot: mealSlots, signup: mealSignups })
    .from(mealSlots)
    .leftJoin(mealSignups, and(eq(mealSignups.slotId, mealSlots.id), isNull(mealSignups.cancelledAt)))
    .where(inArray(mealSlots.pageId, pageIds))
    .orderBy(asc(mealSlots.date), asc(mealSlots.meal));
}

export type Coverage = {
  /** The last date before the first uncovered one: every date from today through it is taken. Null when the next date is open (or none is left). */
  coveredThrough: string | null;
  /** Dates from today on that nobody has taken. */
  openDates: number;
  nextOpenDate: string | null;
};

/** PURE. Withdrawn and past dates do not count. */
export function coverageOf(rows: SlotRow[], today: string): Coverage {
  const upcoming = rows.filter((r) => r.slot.status === "open" && r.slot.date >= today);
  const open = upcoming.filter((r) => !r.signup);
  const firstOpen = open[0]?.slot.date ?? null;
  const covered = upcoming.filter((r) => r.signup && (firstOpen === null || r.slot.date < firstOpen));
  return { coveredThrough: covered.at(-1)?.slot.date ?? null, openDates: open.length, nextOpenDate: firstOpen };
}

/**
 * Move a page from one of `from` to `to`, atomically, recording who paused it while it is paused.
 * `onlyPausedBy`: leave a pause someone else made alone. Null: it was not in one of those states.
 */
export async function transition(db: Db, pageId: string, from: MealPageStatus[], to: MealPageStatus, now: Date, by: "organiser" | "family", onlyPausedBy?: "family"): Promise<MealPage | null> {
  const [row] = await db
    .update(mealPages)
    .set({ status: to, pausedBy: to === "paused" ? by : null, ...(to === "ended" ? { endedAt: now } : {}) })
    .where(and(eq(mealPages.id, pageId), inArray(mealPages.status, from), ...(onlyPausedBy ? [eq(mealPages.pausedBy, onlyPausedBy)] : [])))
    .returning();
  return row ?? null;
}

const UNIQUE_VIOLATION = "23505";
export const isTaken = (error: unknown) => error instanceof DatabaseError && error.code === UNIQUE_VIOLATION;

export type ClaimValues = Omit<typeof mealSignups.$inferInsert, "manageTokenHash" | "id">;

/**
 * Take a date. The partial unique index (one active sign-up per slot) decides:
 * of two people who press at once exactly one insert succeeds, and the other is
 * told the night was just taken. The manage token is returned here and never again.
 */
export async function claimSlot(db: Db, values: ClaimValues): Promise<{ signup: MealSignup; manageToken: string } | "taken"> {
  const manageToken = newToken();
  try {
    const [signup] = await db
      .insert(mealSignups)
      .values({ ...values, manageTokenHash: tokenHash(manageToken) })
      .returning();
    return { signup, manageToken };
  } catch (error) {
    if (isTaken(error)) return "taken";
    throw error;
  }
}

/** What a helper is told once they have signed up, and only then: where and when to bring it. */
export type DeliveryDetails = {
  title: string;
  date: string;
  meal: MealSlot["meal"];
  dropOffAddress: string | null;
  dropOffIsHome: boolean;
  dropOffWindow: string | null;
  dropOffInstructions: string | null;
  foodFor: string | null;
  kashrut: MealPage["kashrut"];
  dietary: string[];
  allergies: string | null;
};

export function deliveryDetails(page: MealPage, slot: MealSlot): DeliveryDetails {
  return {
    title: page.title,
    date: slot.date,
    meal: slot.meal,
    dropOffAddress: page.dropOffAddress,
    dropOffIsHome: page.dropOffIsHome,
    dropOffWindow: page.dropOffWindow,
    dropOffInstructions: page.dropOffInstructions,
    foodFor: page.foodFor,
    kashrut: page.kashrut,
    dietary: page.dietary,
    allergies: page.allergies,
  };
}
