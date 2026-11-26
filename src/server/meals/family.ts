/**
 * The family's own private link. NO ACTOR: the family token is the only key, and it
 * opens only this: who is coming and when, the food needs and drop-off window and
 * instructions (which they may change), pausing and ending their page, resuming a
 * pause they made themselves, and thanking a helper. It never gives a helper's
 * email, the public or manage links, or anything about the organisers or the care
 * record. Once the page has ended it shows only who helped, so they can still be
 * thanked; thirty days later the link stops resolving (./purge.ts).
 */
import { and, eq, exists, isNull } from "drizzle-orm";
import { writeLinkAudit, type AuditAction } from "@/server/care/audit";
import { isUuid } from "@/server/care/validate";
import { mealPages, mealSignups, mealSlots } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { loadSlots, transition, type MealPage, type MealPageStatus, type MealSignup, type MealSlot } from "./core";
import { badFields, FAMILY_FIELDS, familyPatch, thanksInput } from "./input";
import type { Refused } from "./public";
import { LIMITS, readClient, withinLimit } from "./rate-limit";
import { tokenHash } from "./tokens";

export type FamilyDate = {
  slotId: string;
  date: string;
  meal: MealSlot["meal"];
  past: boolean;
  /** Who is coming: their name and what they are bringing. Never their email. */
  helper: { signupId: string; firstName: string | null; lastName: string | null; kind: MealSignup["kind"]; bringing: string | null; foodType: MealSignup["foodType"]; note: string | null; thanked: boolean } | null;
};
export type FamilyView =
  | (Pick<MealPage, "title" | "foodFor" | "kashrut" | "dietary" | "allergies" | "dropOffWindow" | "dropOffInstructions"> & {
      status: Exclude<MealPageStatus, "ended">;
      /** Paused by the family themselves, so theirs to resume. A pause the organiser made is the organiser's to lift. */
      canResume: boolean;
      today: string;
      /** Today's dates, first. */
      tonight: FamilyDate[];
      dates: FamilyDate[];
    })
  /** An ended page: only the dates someone brought a meal on, to thank them. No food needs, window or instructions. */
  | { status: "ended"; title: string; today: string; helped: FamilyDate[] };

async function pageByFamilyToken(db: Db, token: unknown): Promise<MealPage | null> {
  const [page] = await db.select().from(mealPages).where(eq(mealPages.familyTokenHash, tokenHash(token))).limit(1);
  return page ?? null;
}

async function familyView(db: Db, page: MealPage, now: Date): Promise<FamilyView> {
  const today = chicagoToday(now);
  const rows = await loadSlots(db, [page.id]);
  const dates = rows
    .filter((r) => r.slot.status === "open")
    .map(({ slot, signup }): FamilyDate => ({
      slotId: slot.id,
      date: slot.date,
      meal: slot.meal,
      past: slot.date < today,
      helper: signup && {
        signupId: signup.id,
        firstName: signup.firstName,
        lastName: signup.lastName,
        kind: signup.kind,
        bringing: signup.bringing,
        foodType: signup.foodType,
        note: signup.note,
        thanked: signup.thankedAt !== null,
      },
    }));
  if (page.status === "ended") return { status: "ended", title: page.title, today, helped: dates.filter((d) => d.helper) };
  return {
    title: page.title,
    status: page.status,
    canResume: page.status === "paused" && page.pausedBy === "family",
    foodFor: page.foodFor,
    kashrut: page.kashrut,
    dietary: page.dietary,
    allergies: page.allergies,
    dropOffWindow: page.dropOffWindow,
    dropOffInstructions: page.dropOffInstructions,
    today,
    tonight: dates.filter((d) => d.date === today),
    dates,
  };
}

/** Null: no such link, or one already purged. */
export async function getFamilyView(db: Db, familyToken: unknown, now: Date = new Date()): Promise<FamilyView | null> {
  const page = await pageByFamilyToken(db, familyToken);
  return page ? familyView(db, page, now) : null;
}

export type FamilyResult = { ok: true; view: FamilyView } | Refused;
const refused = (reason: Refused["reason"], fields?: string[]): Refused => ({ ok: false, reason, ...(fields ? { fields } : {}) });

async function familyAttempt(db: Db, familyToken: unknown, clientMeta: unknown, now: Date): Promise<MealPage | Refused> {
  const client = readClient(clientMeta, now, false);
  if (!client) return refused("invalid", ["clientMeta"]);
  if (!(await withinLimit(db, `family:client:${client.hash}`, LIMITS.familyPerClient, now))) return refused("rate_limited");
  return (await pageByFamilyToken(db, familyToken)) ?? refused("not_found");
}

/** The food fields and the drop-off window and instructions, and nothing else: any other key is refused. */
export async function updateFoodNeeds(db: Db, familyToken: unknown, patch: unknown, clientMeta: unknown, now: Date = new Date()): Promise<FamilyResult> {
  const page = await familyAttempt(db, familyToken, clientMeta, now);
  if ("ok" in page) return page;
  if (page.status === "ended") return refused("closed");
  const parsed = familyPatch.safeParse(patch);
  if (!parsed.success) return refused("invalid", badFields(parsed.error));
  const fields = FAMILY_FIELDS.filter((f) => parsed.data[f] !== undefined);
  if (fields.length === 0) return { ok: true, view: await familyView(db, page, now) };
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(mealPages).set(parsed.data).where(eq(mealPages.id, page.id)).returning();
    await writeLinkAudit(tx, "family", "meal_page.family_change", "meal_page", page.id, { fields });
    return updated;
  });
  return { ok: true, view: await familyView(db, row, now) };
}

async function familyStatus(db: Db, familyToken: unknown, clientMeta: unknown, now: Date, from: MealPageStatus[], to: MealPageStatus, action: AuditAction, onlyPausedBy?: "family"): Promise<FamilyResult> {
  const page = await familyAttempt(db, familyToken, clientMeta, now);
  if ("ok" in page) return page;
  const row = await db.transaction(async (tx) => {
    const moved = await transition(tx, page.id, from, to, now, "family", onlyPausedBy);
    if (moved) await writeLinkAudit(tx, "family", action, "meal_page", page.id);
    return moved;
  });
  return row ? { ok: true, view: await familyView(db, row, now) } : refused("closed");
}

/** Stop sign-ups and deliveries for now. */
export const familyPause = (db: Db, familyToken: unknown, clientMeta: unknown, now: Date = new Date()) => familyStatus(db, familyToken, clientMeta, now, ["live"], "paused", "meal_page.pause");
/** Lift a pause the family made. One the organiser made is refused ("closed"): only an organiser lifts it. */
export const familyResume = (db: Db, familyToken: unknown, clientMeta: unknown, now: Date = new Date()) => familyStatus(db, familyToken, clientMeta, now, ["paused"], "live", "meal_page.resume", "family");
/** End the page for good. A draft is the organiser's to end. */
export const familyEnd = (db: Db, familyToken: unknown, clientMeta: unknown, now: Date = new Date()) => familyStatus(db, familyToken, clientMeta, now, ["live", "paused"], "ended", "meal_page.end");

/**
 * A line of thanks to one helper. It is stored on their sign-up and shown when they
 * next open their own link; nothing is sent from here.
 */
export async function thankHelper(db: Db, familyToken: unknown, signupId: unknown, text: unknown, clientMeta: unknown, now: Date = new Date()): Promise<FamilyResult> {
  const page = await familyAttempt(db, familyToken, clientMeta, now);
  if ("ok" in page) return page;
  const parsed = thanksInput.safeParse(text);
  if (!parsed.success) return refused("invalid", ["text"]);
  if (!isUuid(signupId)) return refused("unavailable");
  const onPage = db
    .select({ id: mealSlots.id })
    .from(mealSlots)
    .where(and(eq(mealSlots.pageId, page.id), eq(mealSlots.id, mealSignups.slotId)));
  const thanked = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(mealSignups)
      .set({ thanksText: parsed.data, thankedAt: now })
      .where(and(eq(mealSignups.id, signupId), isNull(mealSignups.cancelledAt), isNull(mealSignups.purgedAt), exists(onPage)))
      .returning({ id: mealSignups.id });
    if (row) await writeLinkAudit(tx, "family", "meal_page.family_change", "meal_page", page.id, { fields: ["thanks"] });
    return row;
  });
  return thanked ? { ok: true, view: await familyView(db, page, now) } : refused("unavailable");
}
