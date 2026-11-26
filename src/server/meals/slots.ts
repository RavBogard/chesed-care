/**
 * The dates of a page, and the helpers on them, from the organiser's side: add and
 * withdraw dates, book for someone who phoned, remove a sign-up (and block its
 * email from the page), and the list of helpers who asked to be called on again.
 */
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { canManageMealPages, deny, mealPageVisibleWhere, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { InvalidInput, NotFound, uuidOrNotFound } from "@/server/care/validate";
import { mealPageBlocks, mealPages, mealSignups, mealSlots } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { claimSlot } from "./core";
import { behalfInput, MAX_DATES, parse, slotInputs } from "./input";
import { getMealPageForOrganiser, loadMealPage, type MealPageForOrganiser } from "./pages";

/** Twice the longest page: lunch and dinner on each of 40 days. */
const MAX_SLOTS = MAX_DATES * 2;

/** PURE. The suggested rhythm: every other day from `start`, for `weeks` weeks (1 to 8). */
export function suggestDates(start: string, weeks: number): string[] {
  const days = Math.min(8, Math.max(1, Math.floor(weeks))) * 7;
  const out: string[] = [];
  for (let i = 0; i < days; i += 2) out.push(addDays(start, i));
  return out;
}

/** Offer more dates. A date that was withdrawn is offered again; one already offered is left as it is. */
export async function addDates(db: Db, actor: Actor, id: unknown, dates: unknown, now: Date = new Date()): Promise<MealPageForOrganiser> {
  const { page } = await loadMealPage(db, actor, id);
  const slots = parse(slotInputs, dates, "dates");
  if (page.status === "ended") throw new InvalidInput("status");
  if (slots.some((s) => s.date < chicagoToday(now))) throw new InvalidInput("dates");
  await db.transaction(async (tx) => {
    await tx
      .insert(mealSlots)
      .values(slots.map((s) => ({ pageId: page.id, ...s })))
      .onConflictDoUpdate({ target: [mealSlots.pageId, mealSlots.date, mealSlots.meal], set: { status: "open" } });
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(mealSlots).where(eq(mealSlots.pageId, page.id));
    if (n > MAX_SLOTS) throw new InvalidInput("dates");
  });
  return getMealPageForOrganiser(db, actor, page.id, now);
}

/**
 * Take a date off the page. If someone had taken it their sign-up is kept, and the
 * organiser sees it as needing a call until they remove it.
 */
export async function withdrawDate(db: Db, actor: Actor, id: unknown, slotId: unknown, now: Date = new Date()): Promise<MealPageForOrganiser> {
  const { page } = await loadMealPage(db, actor, id);
  const slot = uuidOrNotFound(slotId);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(mealSlots)
      .set({ status: "withdrawn" })
      .where(and(eq(mealSlots.id, slot), eq(mealSlots.pageId, page.id)))
      .returning({ id: mealSlots.id });
    if (!row) throw new NotFound();
    await writeAudit(tx, actor, "meal_page.withdraw_date", "meal_page", page.id, { by: "organiser", slotId: row.id });
  });
  return getMealPageForOrganiser(db, actor, page.id, now);
}

/**
 * Book a date for someone who phoned or said so in person. A first name is enough.
 * The manage link is returned once, for the organiser to pass on if they wish.
 */
export async function bookOnBehalf(db: Db, actor: Actor, id: unknown, slotId: unknown, input: unknown): Promise<{ signupId: string; manageToken: string }> {
  const { page } = await loadMealPage(db, actor, id);
  const values = parse(behalfInput, input);
  if (page.status === "ended") throw new InvalidInput("status");
  const [slot] = await db
    .select({ id: mealSlots.id })
    .from(mealSlots)
    .where(and(eq(mealSlots.id, uuidOrNotFound(slotId)), eq(mealSlots.pageId, page.id), eq(mealSlots.status, "open")))
    .limit(1);
  if (!slot) throw new NotFound();
  // The date and its audit row are one transaction. A throw inside rolls both back.
  return db.transaction(async (tx) => {
    const claimed = await claimSlot(tx, { ...values, slotId: slot.id, bookedBy: actor.id });
    if (claimed === "taken") throw new InvalidInput("slotId");
    await writeAudit(tx, actor, "meal_signup.create", "meal_signup", claimed.signup.id, { mealPageId: page.id, slotId: slot.id, by: "organiser" });
    return { signupId: claimed.signup.id, manageToken: claimed.manageToken };
  });
}

/** Remove a helper from a date, which opens it again. `blockEmail` also stops that email signing up to this page. */
export async function removeSignup(db: Db, actor: Actor, id: unknown, signupId: unknown, options: { blockEmail?: boolean } = {}, now: Date = new Date()): Promise<MealPageForOrganiser> {
  const { page } = await loadMealPage(db, actor, id);
  const onPage = db.select({ id: mealSlots.id }).from(mealSlots).where(eq(mealSlots.pageId, page.id));
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .update(mealSignups)
      .set({ cancelledAt: now, cancelledBy: "organiser" })
      .where(and(eq(mealSignups.id, uuidOrNotFound(signupId)), isNull(mealSignups.cancelledAt), inArray(mealSignups.slotId, onPage)))
      .returning({ id: mealSignups.id, email: mealSignups.email });
    if (!removed) throw new NotFound();
    const blocked = options.blockEmail === true && removed.email !== null;
    await writeAudit(tx, actor, "meal_signup.remove", "meal_signup", removed.id, { mealPageId: page.id, by: "organiser", blocked });
    if (!blocked) return;
    await tx.insert(mealPageBlocks).values({ pageId: page.id, email: removed.email!, blockedBy: actor.id }).onConflictDoNothing();
    await writeAudit(tx, actor, "meal_page.block_email", "meal_page", page.id, { by: "organiser" });
  });
  return getMealPageForOrganiser(db, actor, page.id, now);
}

export type PastHelper = { firstName: string | null; lastName: string | null; email: string; lastHelped: string };

/**
 * People who ticked "CRC may ask me to help another family in future", on pages the
 * actor may manage: name, email and the last date they brought a meal.
 */
export async function listPastHelpers(db: Db, actor: Actor, now: Date = new Date()): Promise<PastHelper[]> {
  if (!canManageMealPages(actor)) deny();
  const rows = await db
    .select({ firstName: mealSignups.firstName, lastName: mealSignups.lastName, email: mealSignups.email, date: mealSlots.date })
    .from(mealSignups)
    .innerJoin(mealSlots, eq(mealSlots.id, mealSignups.slotId))
    .innerJoin(mealPages, eq(mealPages.id, mealSlots.pageId))
    .where(and(eq(mealSignups.mayContactAgain, true), isNull(mealSignups.cancelledAt), isNotNull(mealSignups.email), lte(mealSlots.date, chicagoToday(now)), mealPageVisibleWhere(actor)))
    .orderBy(mealSlots.date);
  const byEmail = new Map<string, PastHelper>();
  // Earliest first, so the last row for an email is their most recent date and name.
  for (const r of rows) byEmail.set(r.email!, { firstName: r.firstName, lastName: r.lastName, email: r.email!, lastHelped: r.date });
  return [...byEmail.values()].sort((a, b) => b.lastHelped.localeCompare(a.lastHelped));
}
