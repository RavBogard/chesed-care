/**
 * The public side of Mitzvah Meals. NO ACTOR: whoever holds a link calls these, and
 * the link will be posted on social media, so every argument is hostile until it
 * has passed ./input.ts.
 *
 * By public token: what the page shows, and signing up. The page is an allow-list
 * built field by field below: never a last name, an email, the address, the
 * drop-off instructions, an organiser, or anything from a care record. The address
 * is given only in answer to a successful sign-up, and afterwards to that helper's
 * manage token.
 *
 * A token that matches nothing gets "not found" and nothing else. Someone who holds
 * a real public token is told when its page is a draft, paused or ended (status and
 * title, nothing else) until the purge, thirty days after it ended; from then on
 * the tokens are blanked and the link is simply not found (./purge.ts).
 *
 * Getting the address costs a sign-up, and a sign-up leaves a trace: every sign-up
 * and every cancellation is an audit row, and a cancelled sign-up stays on the
 * organiser's view of the page.
 */
import { and, eq, exists, gte, isNull } from "drizzle-orm";
import { writeLinkAudit } from "@/server/care/audit";
import { isUuid } from "@/server/care/validate";
import { mealPageBlocks, mealPages, mealSignups, mealSlots } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { claimSlot, CONGREGATION, deliveryDetails, isTaken, loadSlots, type DeliveryDetails, type MealPage, type MealSignup, type MealSlot } from "./core";
import { deliveryIcs } from "./ics";
import { badFields, changeInput, signupInput } from "./input";
import { atLimit, LIMITS, readClient, withinLimit } from "./rate-limit";
import { afterResponse, noticePlaceOpened } from "@/server/notify/notify";
import { tokenHash } from "./tokens";

export type PublicDate = {
  slotId: string;
  date: string;
  meal: MealSlot["meal"];
  past: boolean;
  /** Who has taken it: a first name and the dish, so nobody brings the same thing twice. */
  taken: { firstName: string | null; kind: MealSignup["kind"]; bringing: string | null; foodType: MealSignup["foodType"] } | null;
};
export type PublicMealPage =
  | { status: "draft" | "paused" | "ended"; title: string }
  | {
      status: "live";
      title: string;
      note: string | null;
      congregation: string;
      foodFor: string | null;
      kashrut: MealPage["kashrut"];
      dietary: string[];
      allergies: string | null;
      dropOffWindow: string | null;
      deliveryPlaces: string | null;
      giftCards: string | null;
      giftCardEmail: string | null;
      dates: PublicDate[];
    };

async function pageByPublicToken(db: Db, token: unknown): Promise<MealPage | null> {
  const [page] = await db.select().from(mealPages).where(eq(mealPages.publicTokenHash, tokenHash(token))).limit(1);
  return page ?? null;
}

/** What anyone with the link sees. A page that is not live gives its status and title, nothing more. Null: no such page, or one already purged. */
export async function getPublicMealPage(db: Db, token: unknown, now: Date = new Date()): Promise<PublicMealPage | null> {
  const page = await pageByPublicToken(db, token);
  if (!page) return null;
  if (page.status !== "live") return { status: page.status, title: page.title };
  const today = chicagoToday(now);
  const rows = await loadSlots(db, [page.id]);
  return {
    status: "live",
    title: page.title,
    note: page.note,
    congregation: CONGREGATION,
    foodFor: page.foodFor,
    kashrut: page.kashrut,
    dietary: page.dietary,
    allergies: page.allergies,
    dropOffWindow: page.dropOffWindow,
    deliveryPlaces: page.deliveryPlaces,
    giftCards: page.giftCards,
    giftCardEmail: page.giftCardEmail,
    dates: rows
      .filter((r) => r.slot.status === "open")
      .map(({ slot, signup }) => ({
        slotId: slot.id,
        date: slot.date,
        meal: slot.meal,
        past: slot.date < today,
        taken: signup && { firstName: signup.firstName, kind: signup.kind, bringing: signup.bringing, foodType: signup.foodType },
      })),
  };
}

export type Refusal =
  /** No page or sign-up answers to that token. */
  | "not_found"
  /** The page is not taking sign-ups or changes (draft, paused or ended). */
  | "closed"
  /** Not accepted, without saying why (a blocked email, or it did not look like a person). */
  | "refused"
  | "rate_limited"
  | "invalid"
  /** That date is past, withdrawn or not on this page. */
  | "unavailable"
  /** Someone just took that night. */
  | "taken";
export type Refused = { ok: false; reason: Refusal; fields?: string[] };
const refused = (reason: Refusal, fields?: string[]): Refused => ({ ok: false, reason, ...(fields ? { fields } : {}) });

/** Thrown inside a transaction to roll it back when the date was just taken. */
class SlotTaken extends Error {}

export type SignUpResult = { ok: true; signupId: string; manageToken: string; details: DeliveryDetails } | Refused;

/**
 * Sign up for a date. On success the helper is given, once, their manage token and
 * the private details: where and when to bring the meal.
 */
export async function signUpForMeal(db: Db, token: unknown, slotId: unknown, input: unknown, clientMeta: unknown, now: Date = new Date()): Promise<SignUpResult> {
  const client = readClient(clientMeta, now, true);
  if (!client) return refused("invalid", ["clientMeta"]);
  if (!(await withinLimit(db, `signup:client:${client.hash}`, LIMITS.signupPerClient, now))) return refused("rate_limited");
  const page = await pageByPublicToken(db, token);
  if (!page) return refused("not_found");
  if (page.status !== "live") return refused("closed");
  if (client.bot) return refused("refused");
  const parsed = signupInput.safeParse(input);
  if (!parsed.success) return refused("invalid", badFields(parsed.error));
  // The page's own ceiling counts only sign-ups that succeed (charged below), so junk
  // attempts cannot lock a family's page; they are held by the per-client limit above.
  const pageKey = `signup:page:${page.id}`;
  if (await atLimit(db, pageKey, LIMITS.signupPerPage, now)) return refused("rate_limited");
  const [blocked] = await db
    .select({ email: mealPageBlocks.email })
    .from(mealPageBlocks)
    .where(and(eq(mealPageBlocks.pageId, page.id), eq(mealPageBlocks.email, parsed.data.email)))
    .limit(1);
  if (blocked) return refused("refused");
  if (!isUuid(slotId)) return refused("unavailable");
  const [slot] = await db
    .select()
    .from(mealSlots)
    .where(and(eq(mealSlots.id, slotId), eq(mealSlots.pageId, page.id), eq(mealSlots.status, "open"), gte(mealSlots.date, chicagoToday(now))))
    .limit(1);
  if (!slot) return refused("unavailable");
  // The date and its audit row are one transaction: a sign-up that is not recorded is not kept.
  const claimed = await db
    .transaction(async (tx) => {
      const made = await claimSlot(tx, { ...parsed.data, slotId: slot.id });
      if (made === "taken") throw new SlotTaken();
      await writeLinkAudit(tx, "helper", "meal_signup.create", "meal_signup", made.signup.id, { mealPageId: page.id, slotId: slot.id });
      return made;
    })
    .catch((error) => (error instanceof SlotTaken ? ("taken" as const) : Promise.reject(error)));
  if (claimed === "taken") return refused("taken");
  await withinLimit(db, pageKey, LIMITS.signupPerPage, now);
  return { ok: true, signupId: claimed.signup.id, manageToken: claimed.manageToken, details: deliveryDetails(page, slot) };
}

// ─── by manage token ─────────────────────────────────────────────────────────────────

type Mine = { signup: MealSignup; slot: MealSlot; page: MealPage };

async function byManageToken(db: Db, token: unknown): Promise<Mine | null> {
  const [row] = await db
    .select({ signup: mealSignups, slot: mealSlots, page: mealPages })
    .from(mealSignups)
    .innerJoin(mealSlots, eq(mealSlots.id, mealSignups.slotId))
    .innerJoin(mealPages, eq(mealPages.id, mealSlots.pageId))
    // A purged sign-up's link stops resolving: its page's links are gone too.
    .where(and(eq(mealSignups.manageTokenHash, tokenHash(token)), isNull(mealSignups.purgedAt)))
    .limit(1);
  return row ?? null;
}

type MyState = "active" | "cancelled" | "withdrawn" | "paused" | "ended";

function stateOf({ signup, slot, page }: Mine): MyState {
  if (signup.cancelledAt) return "cancelled";
  if (page.status === "ended") return "ended";
  if (page.status !== "live") return "paused";
  return slot.status === "withdrawn" ? "withdrawn" : "active";
}

export type Thanks = { text: string; at: Date };
export type MySignup =
  | {
      state: "active";
      signupId: string;
      details: DeliveryDetails;
      firstName: string | null;
      kind: MealSignup["kind"];
      bringing: string | null;
      foodType: MealSignup["foodType"];
      note: string | null;
      /** Other dates still open, to move to. */
      openDates: { slotId: string; date: string; meal: MealSlot["meal"] }[];
      thanks: Thanks | null;
    }
  /** No longer a delivery to make: no address or instructions are given. */
  | { state: Exclude<MyState, "active">; title: string; date: string; meal: MealSlot["meal"]; thanks: Thanks | null };

async function view(db: Db, mine: Mine, now: Date): Promise<MySignup> {
  const { signup, slot, page } = mine;
  const state = stateOf(mine);
  const thanks = signup.thanksText && signup.thankedAt ? { text: signup.thanksText, at: signup.thankedAt } : null;
  if (state !== "active") return { state, title: page.title, date: slot.date, meal: slot.meal, thanks };
  const today = chicagoToday(now);
  const rows = await loadSlots(db, [page.id]);
  return {
    state,
    signupId: signup.id,
    details: deliveryDetails(page, slot),
    firstName: signup.firstName,
    kind: signup.kind,
    bringing: signup.bringing,
    foodType: signup.foodType,
    note: signup.note,
    openDates: rows.filter((r) => r.slot.status === "open" && !r.signup && r.slot.date >= today).map((r) => ({ slotId: r.slot.id, date: r.slot.date, meal: r.slot.meal })),
    thanks,
  };
}

/** A helper's own sign-up: the private details while it stands, and the family's thanks if they sent any. Null: no such link. */
export async function getMySignup(db: Db, manageToken: unknown, now: Date = new Date()): Promise<MySignup | null> {
  const mine = await byManageToken(db, manageToken);
  return mine ? view(db, mine, now) : null;
}

export type ChangeResult = { ok: true; signup: MySignup } | Refused;

async function manageAttempt(db: Db, manageToken: unknown, clientMeta: unknown, now: Date): Promise<Mine | Refused> {
  const client = readClient(clientMeta, now, false);
  if (!client) return refused("invalid", ["clientMeta"]);
  if (!(await withinLimit(db, `manage:client:${client.hash}`, LIMITS.managePerClient, now))) return refused("rate_limited");
  return (await byManageToken(db, manageToken)) ?? refused("not_found");
}

/**
 * Change what one is bringing, or move to another open date. The move is a single
 * statement: the old date opens and the new one is taken together, or neither.
 */
export async function changeMySignup(db: Db, manageToken: unknown, patch: unknown, clientMeta: unknown, now: Date = new Date()): Promise<ChangeResult> {
  const mine = await manageAttempt(db, manageToken, clientMeta, now);
  if ("ok" in mine) return mine;
  if (stateOf(mine) !== "active") return refused("closed");
  const parsed = changeInput.safeParse(patch);
  if (!parsed.success) return refused("invalid", badFields(parsed.error));
  const { moveToSlotId, ...fields } = parsed.data;
  // Nothing asked for: the sign-up as it stands.
  if (!moveToSlotId && Object.values(fields).every((v) => v === undefined)) return { ok: true, signup: await view(db, mine, now) };
  const target = (q: Db) =>
    q
      .select({ id: mealSlots.id })
      .from(mealSlots)
      .where(and(eq(mealSlots.id, moveToSlotId ?? mine.slot.id), eq(mealSlots.pageId, mine.page.id), eq(mealSlots.status, "open"), gte(mealSlots.date, chicagoToday(now))));
  try {
    // The new date and its audit row are one transaction: nothing is moved that is not recorded.
    const moved = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(mealSignups)
        .set({ ...fields, ...(moveToSlotId ? { slotId: moveToSlotId } : {}) })
        .where(and(eq(mealSignups.id, mine.signup.id), isNull(mealSignups.cancelledAt), ...(moveToSlotId ? [exists(target(tx))] : [])))
        .returning({ id: mealSignups.id });
      if (row && moveToSlotId && moveToSlotId !== mine.slot.id) await writeLinkAudit(tx, "helper", "meal_signup.move", "meal_signup", row.id, { mealPageId: mine.page.id, fromSlotId: mine.slot.id, slotId: moveToSlotId });
      return row;
    });
    if (!moved) return refused("unavailable");
  } catch (error) {
    if (isTaken(error)) return refused("taken");
    throw error;
  }
  const after = await byManageToken(db, manageToken);
  return after ? { ok: true, signup: await view(db, after, now) } : refused("not_found");
}

/** Give the date back. It opens again at once. Cancelling twice is not an error. */
export async function cancelMySignup(db: Db, manageToken: unknown, clientMeta: unknown, now: Date = new Date()): Promise<{ ok: true } | Refused> {
  const mine = await manageAttempt(db, manageToken, clientMeta, now);
  if ("ok" in mine) return mine;
  // An ended page takes no more changes. A sign-up already cancelled is simply still cancelled.
  if (stateOf(mine) === "ended") return refused("closed");
  if (mine.signup.cancelledAt) return { ok: true };
  const cancelledNow = await db.transaction(async (tx) => {
    const [cancelled] = await tx
      .update(mealSignups)
      .set({ cancelledAt: now, cancelledBy: "helper" })
      .where(and(eq(mealSignups.id, mine.signup.id), isNull(mealSignups.cancelledAt)))
      .returning({ id: mealSignups.id });
    if (cancelled) await writeLinkAudit(tx, "helper", "meal_signup.cancel", "meal_signup", cancelled.id, { mealPageId: mine.page.id, slotId: mine.slot.id });
    return cancelled !== undefined;
  });
  // The organisers hear (fixed words, after the response) when a night is given back close to its date.
  if (cancelledNow) afterResponse(() => noticePlaceOpened(db, { mealPageId: mine.page.id, slotDate: mine.slot.date }, now));
  return { ok: true };
}

/** The delivery as a calendar file (./ics.ts), while the sign-up stands. Null otherwise. */
export async function mealSignupIcs(db: Db, manageToken: unknown, now: Date = new Date()): Promise<string | null> {
  const mine = await byManageToken(db, manageToken);
  if (!mine || stateOf(mine) !== "active") return null;
  const { signup, slot, page } = mine;
  return deliveryIcs({
    uid: signup.id,
    date: slot.date,
    nextDay: addDays(slot.date, 1),
    summary: `Mitzvah Meals: ${slot.meal} for ${page.title}`,
    address: page.dropOffAddress,
    window: page.dropOffWindow,
    stamp: now,
  });
}
