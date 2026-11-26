/**
 * The organiser's side of a Mitzvah Meals page: set it up, edit it, take it live,
 * pause and end it, share the work with co-organisers, and read it in full. Every
 * function takes the acting user and asks the access policy. A page linked to a
 * care item shows that link only to those who fully read the item, and copies
 * nothing from it but who it is about.
 */
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { canLinkMealPageToCareItem, canManageMealPages, canOrganiseMealPages, canSeeCareItem, canSeeMealFamilyLink, canSeeMealPage, coOrganiserOf, deny, mealPageVisibleWhere, namedOn, type Actor } from "@/server/access/policy";
import { writeAudit, type AuditAction, type MealAuditField } from "@/server/care/audit";
import { loadVisibleCareItemAccess } from "@/server/care/care-items";
import { getOutsidePerson } from "@/server/care/outside-people";
import { contactIdField, InvalidInput, NotFound, optionalAccountIdField, uuidField, uuidOrNotFound } from "@/server/care/validate";
import { careItems, mealPageBlocks, mealPageOrganisers, mealPages, mealSignups, mealSlots, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { coverageOf, loadSlots, transition, type Coverage, type MealPage, type MealPageStatus, type MealSignup, type MealSlot, type SlotRow } from "./core";
import { createPageInput, pagePatch, parse } from "./input";
import { newToken, tokenHash } from "./tokens";

/** Where the organiser finishes and runs a page in the app. */
export const mealPagePath = (pageId: string) => `/meals/${pageId}`;

export type OrganiserSignup = Pick<MealSignup, "id" | "firstName" | "lastName" | "email" | "kind" | "bringing" | "foodType" | "note" | "mayContactAgain" | "createdAt" | "thankedAt"> & {
  /** An organiser booked this for the helper. */
  onBehalf: boolean;
};
export type OrganiserSlot = Pick<MealSlot, "id" | "date" | "meal" | "status"> & {
  past: boolean;
  signup: OrganiserSignup | null;
  /** Withdrawn while someone had taken it: that helper needs a call. */
  needsCall: boolean;
};
type PageFields = Pick<
  MealPage,
  | "id"
  | "title"
  | "note"
  | "status"
  | "pausedBy"
  | "familyAgreedAt"
  | "familyAgreedBy"
  | "foodFor"
  | "kashrut"
  | "dietary"
  | "allergies"
  | "dropOffWindow"
  | "dropOffInstructions"
  | "dropOffAddress"
  | "dropOffIsHome"
  | "deliveryPlaces"
  | "giftCards"
  | "giftCardEmail"
  | "sfContactId"
  | "sfAccountId"
  | "outsidePersonId"
  | "organiserUserId"
  | "endedAt"
  | "createdAt"
>;
/**
 * A sign-up that no longer stands, kept in sight: someone who signs up (and so is
 * given the address) and then cancels shows here, with who cancelled it.
 */
export type CancelledSignup = Pick<MealSignup, "id" | "firstName" | "lastName" | "email" | "cancelledAt" | "cancelledBy"> & Pick<MealSlot, "date" | "meal">;
/** Everything, for an organiser: the helpers' emails and the links included. */
export type MealPageForOrganiser = PageFields & {
  /** Null unless the actor fully reads the care item. */
  careItemId: string | null;
  /** Null once the purge has blanked it, thirty days after the page ended. */
  publicToken: string | null;
  /** Null unless the actor organises the page or is clergy level (canSeeMealFamilyLink), and once purged. */
  familyToken: string | null;
  organisers: { userId: string; name: string; lead: boolean }[];
  slots: OrganiserSlot[];
  /** Most recently cancelled first. */
  cancelledSignups: CancelledSignup[];
  blockedEmails: string[];
  coverage: Coverage;
  today: string;
};
export type MealPageSummary = Pick<MealPage, "id" | "title" | "status" | "createdAt"> & Coverage & { needsCall: number; mine: boolean };

export type LoadedPage = { page: MealPage; careLinkVisible: boolean; familyLinkVisible: boolean };

/** A page the actor may manage, or NotFound (missing and hidden look the same). */
export async function loadMealPage(db: Db, actor: Actor, id: unknown): Promise<LoadedPage> {
  if (!canManageMealPages(actor)) deny();
  const [row] = await db
    .select({ page: mealPages, coOrganiser: coOrganiserOf(actor), item: careItems, named: namedOn(actor) })
    .from(mealPages)
    .leftJoin(careItems, eq(careItems.id, mealPages.careItemId))
    .where(eq(mealPages.id, uuidOrNotFound(id)))
    .limit(1);
  if (!row) throw new NotFound();
  const item = row.item ? { ...row.item, named: row.named === true } : null;
  const access = { organiserUserId: row.page.organiserUserId, coOrganiser: row.coOrganiser === true, careItem: item };
  if (!canSeeMealPage(actor, access)) throw new NotFound();
  return { page: row.page, careLinkVisible: item !== null && canSeeCareItem(actor, item), familyLinkVisible: canSeeMealFamilyLink(actor, access) };
}

const needsCall = (r: SlotRow) => r.slot.status === "withdrawn" && r.signup !== null;

function organiserSlot({ slot, signup }: SlotRow, today: string): OrganiserSlot {
  return {
    id: slot.id,
    date: slot.date,
    meal: slot.meal,
    status: slot.status,
    past: slot.date < today,
    needsCall: needsCall({ slot, signup }),
    signup: signup && {
      id: signup.id,
      firstName: signup.firstName,
      lastName: signup.lastName,
      email: signup.email,
      kind: signup.kind,
      bringing: signup.bringing,
      foodType: signup.foodType,
      note: signup.note,
      mayContactAgain: signup.mayContactAgain,
      createdAt: signup.createdAt,
      thankedAt: signup.thankedAt,
      onBehalf: signup.bookedBy !== null,
    },
  };
}

export async function getMealPageForOrganiser(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<MealPageForOrganiser> {
  const { page, careLinkVisible, familyLinkVisible } = await loadMealPage(db, actor, id);
  const today = chicagoToday(now);
  const [rows, cancelledSignups, co, blocks, [lead]] = await Promise.all([
    loadSlots(db, [page.id]),
    db
      .select({ id: mealSignups.id, firstName: mealSignups.firstName, lastName: mealSignups.lastName, email: mealSignups.email, cancelledAt: mealSignups.cancelledAt, cancelledBy: mealSignups.cancelledBy, date: mealSlots.date, meal: mealSlots.meal })
      .from(mealSignups)
      .innerJoin(mealSlots, eq(mealSlots.id, mealSignups.slotId))
      .where(and(eq(mealSlots.pageId, page.id), isNotNull(mealSignups.cancelledAt)))
      .orderBy(desc(mealSignups.cancelledAt), asc(mealSlots.date)),
    db
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(mealPageOrganisers)
      .innerJoin(users, eq(users.id, mealPageOrganisers.userId))
      .where(eq(mealPageOrganisers.pageId, page.id))
      .orderBy(asc(users.email)),
    db.select({ email: mealPageBlocks.email }).from(mealPageBlocks).where(eq(mealPageBlocks.pageId, page.id)).orderBy(asc(mealPageBlocks.email)),
    db.select({ userId: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, page.organiserUserId)).limit(1),
  ]);
  // Listed field by field: the token hashes and created_by stay behind.
  return {
    id: page.id,
    title: page.title,
    note: page.note,
    status: page.status,
    pausedBy: page.pausedBy,
    familyAgreedAt: page.familyAgreedAt,
    familyAgreedBy: page.familyAgreedBy,
    foodFor: page.foodFor,
    kashrut: page.kashrut,
    dietary: page.dietary,
    allergies: page.allergies,
    dropOffWindow: page.dropOffWindow,
    dropOffInstructions: page.dropOffInstructions,
    dropOffAddress: page.dropOffAddress,
    dropOffIsHome: page.dropOffIsHome,
    deliveryPlaces: page.deliveryPlaces,
    giftCards: page.giftCards,
    giftCardEmail: page.giftCardEmail,
    sfContactId: page.sfContactId,
    sfAccountId: page.sfAccountId,
    outsidePersonId: page.outsidePersonId,
    organiserUserId: page.organiserUserId,
    endedAt: page.endedAt,
    createdAt: page.createdAt,
    careItemId: careLinkVisible ? page.careItemId : null,
    publicToken: page.publicToken,
    familyToken: familyLinkVisible ? page.familyToken : null,
    cancelledSignups,
    organisers: [...(lead ? [{ userId: lead.userId, name: lead.name ?? lead.email, lead: true }] : []), ...co.map((u) => ({ userId: u.userId, name: u.name ?? u.email, lead: false }))],
    slots: rows.map((r) => organiserSlot(r, today)),
    blockedEmails: blocks.map((b) => b.email),
    coverage: coverageOf(rows, today),
    today,
  };
}

/** The pages the actor may manage, newest first, each with its coverage. */
export async function listMealPages(db: Db, actor: Actor, now: Date = new Date()): Promise<MealPageSummary[]> {
  if (!canManageMealPages(actor)) deny();
  const pages = await db
    .select({ id: mealPages.id, title: mealPages.title, status: mealPages.status, createdAt: mealPages.createdAt, organiserUserId: mealPages.organiserUserId, coOrganiser: coOrganiserOf(actor) })
    .from(mealPages)
    .where(mealPageVisibleWhere(actor))
    .orderBy(desc(mealPages.createdAt));
  const today = chicagoToday(now);
  const rows = await loadSlots(db, pages.map((p) => p.id));
  return pages.map(({ organiserUserId, coOrganiser, ...p }) => {
    const own = rows.filter((r) => r.slot.pageId === p.id);
    return { ...p, ...coverageOf(own, today), needsCall: own.filter(needsCall).length, mine: organiserUserId === actor.id || coOrganiser === true };
  });
}

type Subject = Pick<MealPage, "careItemId" | "sfContactId" | "sfAccountId" | "outsidePersonId">;

/**
 * Who the page is for. From a care item (only one the actor fully reads: otherwise
 * it is not found, restricted or not), an outside person the actor may open, a
 * Salesforce contact, or nobody on record when the organiser only typed a name.
 */
async function subjectOf(db: Db, actor: Actor, input: { careItemId?: unknown; sfContactId?: unknown; sfAccountId?: unknown; outsidePersonId?: unknown }): Promise<Subject> {
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (given(input.careItemId)) {
    const { item, access } = await loadVisibleCareItemAccess(db, actor, input.careItemId);
    if (!canLinkMealPageToCareItem(actor, access)) throw new NotFound();
    return { careItemId: item.id, sfContactId: item.sfContactId, sfAccountId: item.sfAccountId, outsidePersonId: item.outsidePersonId };
  }
  if (given(input.outsidePersonId)) {
    if (given(input.sfContactId)) throw new InvalidInput("outsidePersonId");
    const person = await getOutsidePerson(db, actor, input.outsidePersonId);
    return { careItemId: null, sfContactId: null, sfAccountId: null, outsidePersonId: person.id };
  }
  return { careItemId: null, sfContactId: given(input.sfContactId) ? contactIdField(input.sfContactId) : null, sfAccountId: optionalAccountIdField(input.sfAccountId), outsidePersonId: null };
}

/** A new page is a draft: it cannot go live until the family has agreed. */
export async function createMealPage(db: Db, actor: Actor, input: unknown, now: Date = new Date()): Promise<MealPageForOrganiser> {
  if (!canManageMealPages(actor)) deny();
  const { dates, careItemId, sfContactId, sfAccountId, outsidePersonId, ...fields } = parse(createPageInput, input);
  const today = chicagoToday(now);
  if (dates?.some((d) => d.date < today)) throw new InvalidInput("dates");
  const subject = await subjectOf(db, actor, { careItemId, sfContactId, sfAccountId, outsidePersonId });
  const [publicToken, familyToken] = [newToken(), newToken()];
  const id = await db.transaction(async (tx) => {
    const [page] = await tx
      .insert(mealPages)
      .values({ ...fields, ...subject, publicToken, publicTokenHash: tokenHash(publicToken), familyToken, familyTokenHash: tokenHash(familyToken), organiserUserId: actor.id, createdBy: actor.id })
      .returning({ id: mealPages.id });
    if (dates?.length) await tx.insert(mealSlots).values(dates.map((d) => ({ pageId: page.id, ...d }))).onConflictDoNothing();
    await writeAudit(tx, actor, "meal_page.create", "meal_page", page.id, { by: "organiser" });
    return page.id;
  });
  return getMealPageForOrganiser(db, actor, id, now);
}

/** The words and food needs of a page. Not its status, its links or who it is for. */
export async function updateMealPage(db: Db, actor: Actor, id: unknown, patch: unknown, now: Date = new Date()): Promise<MealPageForOrganiser> {
  const { page } = await loadMealPage(db, actor, id);
  const set = parse(pagePatch, patch);
  if (page.status === "ended") throw new InvalidInput("status");
  // Where the food goes is the sensitive part of a page: a change to it is recorded, by field name only.
  const fields = WHERE_FIELDS.filter((f) => set[f] !== undefined && set[f] !== page[f]);
  if (Object.keys(set).length)
    await db.transaction(async (tx) => {
      await tx.update(mealPages).set(set).where(eq(mealPages.id, page.id));
      if (fields.length) await writeAudit(tx, actor, "meal_page.update", "meal_page", page.id, { by: "organiser", fields });
    });
  return getMealPageForOrganiser(db, actor, page.id, now);
}

const WHERE_FIELDS = ["dropOffAddress", "dropOffIsHome", "dropOffWindow", "dropOffInstructions"] as const satisfies readonly MealAuditField[];

/** Record that the family said yes, and who heard it. Without this a page stays a draft. */
export async function markFamilyAgreed(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<MealPageForOrganiser> {
  const { page } = await loadMealPage(db, actor, id);
  if (!page.familyAgreedAt) await db.update(mealPages).set({ familyAgreedAt: now, familyAgreedBy: actor.id }).where(eq(mealPages.id, page.id));
  return getMealPageForOrganiser(db, actor, page.id, now);
}

async function changeStatus(db: Db, actor: Actor, id: unknown, from: MealPageStatus[], to: MealPageStatus, action: AuditAction, now: Date, ready: (page: MealPage) => boolean = () => true): Promise<MealPageForOrganiser> {
  const { page } = await loadMealPage(db, actor, id);
  if (!ready(page)) throw new InvalidInput("familyAgreed");
  await db.transaction(async (tx) => {
    if (!(await transition(tx, page.id, from, to, now, "organiser"))) throw new InvalidInput("status");
    await writeAudit(tx, actor, action, "meal_page", page.id, { by: "organiser" });
  });
  return getMealPageForOrganiser(db, actor, page.id, now);
}

/** Draft to live. Refused until the family has agreed (the database refuses it too). */
export const goLive = (db: Db, actor: Actor, id: unknown, now: Date = new Date()) => changeStatus(db, actor, id, ["draft"], "live", "meal_page.go_live", now, (page) => page.familyAgreedAt !== null);
export const pauseMealPage = (db: Db, actor: Actor, id: unknown, now: Date = new Date()) => changeStatus(db, actor, id, ["live"], "paused", "meal_page.pause", now);
export const resumeMealPage = (db: Db, actor: Actor, id: unknown, now: Date = new Date()) => changeStatus(db, actor, id, ["paused"], "live", "meal_page.resume", now);
/** Ending is final. Thirty days later the helpers' names and emails are purged (./purge.ts). */
export const endMealPage = (db: Db, actor: Actor, id: unknown, now: Date = new Date()) => changeStatus(db, actor, id, ["draft", "live", "paused"], "ended", "meal_page.end", now);

/** Share a page with a colleague who may run pages. They see and manage it as the organiser does. */
export async function addCoOrganiser(db: Db, actor: Actor, id: unknown, userId: unknown, now: Date = new Date()): Promise<MealPageForOrganiser> {
  const { page } = await loadMealPage(db, actor, id);
  const target = uuidField(userId, "userId");
  const [user] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, target)).limit(1);
  if (!user || !canOrganiseMealPages(user)) throw new InvalidInput("userId");
  if (target !== page.organiserUserId)
    await db.transaction(async (tx) => {
      const added = await tx.insert(mealPageOrganisers).values({ pageId: page.id, userId: target }).onConflictDoNothing().returning({ userId: mealPageOrganisers.userId });
      if (added.length) await writeAudit(tx, actor, "meal_page.add_organiser", "meal_page", page.id, { by: "organiser", userId: target });
    });
  return getMealPageForOrganiser(db, actor, page.id, now);
}

export async function removeCoOrganiser(db: Db, actor: Actor, id: unknown, userId: unknown, now: Date = new Date()): Promise<MealPageForOrganiser | null> {
  const { page } = await loadMealPage(db, actor, id);
  const target = uuidField(userId, "userId");
  await db.transaction(async (tx) => {
    const removed = await tx.delete(mealPageOrganisers).where(and(eq(mealPageOrganisers.pageId, page.id), eq(mealPageOrganisers.userId, target))).returning({ userId: mealPageOrganisers.userId });
    if (removed.length) await writeAudit(tx, actor, "meal_page.remove_organiser", "meal_page", page.id, { by: "organiser", userId: target });
  });
  // Someone who removes themselves may no longer see the page.
  return getMealPageForOrganiser(db, actor, page.id, now).catch((error) => (error instanceof NotFound ? null : Promise.reject(error)));
}
