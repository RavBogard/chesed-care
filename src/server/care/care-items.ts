import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  canAddDirectly,
  canChangeRestriction,
  canHandOverRestricted,
  canHoldRestricted,
  canManageCareItems,
  canSeeCareItem,
  canSetCorpsNote,
  canSetKeepNotes,
  canSeeStrandedRestricted,
  careItemStubWhere,
  careItemVisibleWhere,
  deny,
  isValidAssignment,
  namedOn,
  type Actor,
  type CareItemAccessRow,
} from "@/server/access/policy";
import { careItemAccess, careItems, followUps, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { endJourneysForItem } from "@/server/journeys/lifecycle";
import { auditRestrictedReads, writeAudit } from "./audit";
import { personSubject, type PersonSubjectInput } from "./outside-people";
import { contactIdField, dateField, InvalidInput, NotFound, oneOf, optionalBool, optionalText, text, uuidField, uuidList, uuidOrNotFound } from "./validate";

export type CareItem = typeof careItems.$inferSelect;
/**
 * All that clergy without access see of a restricted item: the person, that it is
 * restricted, and who holds it. No category, summary, location, source or dates.
 */
export type CareItemStub = { id: string; restricted: true; sfContactId: string | null; outsidePersonId: string | null; displayName: string; ownerUserId: string; ownerName: string | null };

export const CARE_CATEGORIES = ["illness", "bereavement", "birth", "ongoing", "caregiver", "life_change", "mental_health", "simcha", "other"] as const;
export const CARE_SOURCES = ["clergy", "capture", "connector", "email", "form", "staff", "voice", "salesforce", "shortcut"] as const;
const VISIBILITIES = ["clergy", "caregivers"] as const;
const SUMMARY_MAX = 500;
const SHORT_MAX = 200;
const ACCESS_MAX = 20;

const today = () => chicagoToday(new Date());

/** New or open, or paused and due back (see ./status.ts for the same rule over a loaded row). */
export function activeWhere(day: string): SQL {
  return or(inArray(careItems.status, ["new", "open"]), and(eq(careItems.status, "paused"), lte(careItems.pausedUntil, day)))!;
}

/** Paused and not yet due back. */
function pausedWhere(day: string): SQL {
  return and(eq(careItems.status, "paused"), or(isNull(careItems.pausedUntil), gt(careItems.pausedUntil, day)))!;
}

export type Loaded = { item: CareItem; access: CareItemAccessRow };

async function loadCareItem(db: Db, actor: Actor, id: unknown): Promise<Loaded | null> {
  const [row] = await db.select({ item: careItems, named: namedOn(actor) }).from(careItems).where(eq(careItems.id, uuidOrNotFound(id))).limit(1);
  return row ? { item: row.item, access: { ...row.item, named: row.named === true } } : null;
}

/** A care item the actor fully sees, with its access row, or NotFound (missing, hidden and restricted look the same). */
export async function loadVisibleCareItemAccess(db: Db, actor: Actor, id: unknown): Promise<Loaded> {
  const loaded = await loadCareItem(db, actor, id);
  if (!loaded || !canSeeCareItem(actor, loaded.access)) throw new NotFound();
  await auditRestrictedReads(db, actor, [loaded.item]);
  return loaded;
}

export async function loadVisibleCareItem(db: Db, actor: Actor, id: unknown): Promise<CareItem> {
  return (await loadVisibleCareItemAccess(db, actor, id)).item;
}

/** The assignee must be active, a caregiver only for work visible to caregivers, and clergy level for a restricted item. */
export async function assertAssignable(db: Db, ownerUserId: string, visibility: CareItem["visibility"], restricted = false): Promise<void> {
  const [owner] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, ownerUserId)).limit(1);
  if (!owner || !isValidAssignment(owner, visibility)) throw new InvalidInput("ownerUserId");
  if (restricted && !canHoldRestricted(owner)) throw new InvalidInput("ownerUserId");
}

/** Work on a care item (a follow-up) can go only to someone who can see it: on a restricted item, its owner or the clergy named on it. */
export async function assertCanHoldWorkOn(db: Db, userId: string, item: CareItem | null): Promise<void> {
  await assertAssignable(db, userId, item?.visibility ?? "clergy", item?.restricted ?? false);
  if (!item?.restricted || item.ownerUserId === userId) return;
  const [named] = await db
    .select({ userId: careItemAccess.userId })
    .from(careItemAccess)
    .where(and(eq(careItemAccess.careItemId, item.id), eq(careItemAccess.userId, userId)))
    .limit(1);
  if (!named) throw new InvalidInput("ownerUserId");
}

/** The clergy to name on a restricted item: each active and clergy level. The owner needs no row. */
async function accessList(db: Db, value: unknown, ownerUserId: string): Promise<string[]> {
  const ids = uuidList(value, "accessUserIds", ACCESS_MAX).filter((id) => id !== ownerUserId);
  if (ids.length === 0) return [];
  const rows = await db.select({ id: users.id, role: users.role, active: users.active }).from(users).where(inArray(users.id, ids));
  if (rows.length !== ids.length || !rows.every(canHoldRestricted)) throw new InvalidInput("accessUserIds");
  return ids;
}

/**
 * Open follow-ups on a restricted item held by someone who cannot see it do not vanish
 * unnoticed: a Mitzvah Corps step goes to the item's owner (still marked for Mitzvah Corps,
 * as it would have been made on a restricted item), and anything else becomes unassigned.
 */
async function releaseHiddenFollowUps(db: Db, itemId: string, ownerUserId: string): Promise<void> {
  const named = db.select({ id: careItemAccess.userId }).from(careItemAccess).where(eq(careItemAccess.careItemId, itemId));
  const hidden = and(eq(followUps.careItemId, itemId), isNull(followUps.doneAt), isNotNull(followUps.ownerUserId), ne(followUps.ownerUserId, ownerUserId), notInArray(followUps.ownerUserId, named));
  await db.update(followUps).set({ ownerUserId }).where(and(hidden, eq(followUps.forLead, true)));
  await db.update(followUps).set({ ownerUserId: null }).where(hidden);
}

/** New note text on an item whose old notes were cleared: the item is no longer "cleared", so the three-year rule applies to it again from its next close. */
export async function markNotesWritten(db: Db, careItemId: string): Promise<void> {
  await db.update(careItems).set({ notesPurgedAt: null }).where(and(eq(careItems.id, careItemId), isNotNull(careItems.notesPurgedAt)));
}

export type CareItemInput = PersonSubjectInput & {
  category: unknown;
  ownerUserId?: unknown;
  visibility?: unknown;
  summary?: unknown;
  location?: unknown;
  learnedFrom?: unknown;
  source?: unknown;
  restricted?: unknown;
  restrictedShowsCarer?: unknown;
  accessUserIds?: unknown;
};

/** A new care item starts as "new"; the first contact logged makes it "open". */
export async function createCareItem(db: Db, actor: Actor, input: CareItemInput): Promise<CareItem> {
  if (!canManageCareItems(actor)) deny();
  return writeCareItem(db, actor, input);
}

/** The write behind createCareItem. The caller has decided the actor may make this item: clergy level, or staff adding directly (./staff-add.ts). */
export async function writeCareItem(db: Db, actor: Actor, input: CareItemInput): Promise<CareItem> {
  if (!canManageCareItems(actor)) {
    // Staff adding directly: a member, for clergy eyes only, with no one named on it.
    if (!canAddDirectly(actor) || input.visibility !== undefined || input.accessUserIds !== undefined || input.outsidePersonId !== undefined || input.restrictedShowsCarer !== undefined) deny();
  }
  const visibility = input.visibility === undefined ? "clergy" : oneOf(input.visibility, "visibility", VISIBILITIES);
  const restricted = optionalBool(input.restricted, "restricted") ?? false;
  if (restricted && visibility !== "clergy") throw new InvalidInput("restricted");
  const ownerUserId = input.ownerUserId === undefined ? actor.id : uuidField(input.ownerUserId, "ownerUserId");
  await assertAssignable(db, ownerUserId, visibility, restricted);
  const access = await accessList(db, input.accessUserIds, ownerUserId);
  if (access.length > 0 && !restricted) throw new InvalidInput("accessUserIds");
  const subject = await personSubject(db, actor, input, true);
  const values = {
    sfContactId: subject.sfContactId,
    outsidePersonId: subject.outsidePersonId,
    sfAccountId: subject.sfAccountId,
    displayName: subject.displayName!,
    category: oneOf(input.category, "category", CARE_CATEGORIES),
    status: "new" as const,
    summary: optionalText(input.summary, "summary", SUMMARY_MAX),
    location: optionalText(input.location, "location", SHORT_MAX),
    learnedFrom: optionalText(input.learnedFrom, "learnedFrom", SHORT_MAX),
    source: input.source === undefined ? ("clergy" as const) : oneOf(input.source, "source", CARE_SOURCES),
    restricted,
    restrictedShowsCarer: optionalBool(input.restrictedShowsCarer, "restrictedShowsCarer") ?? true,
    ownerUserId,
    visibility,
    createdBy: actor.id,
  };
  return db.transaction(async (tx) => {
    const [item] = await tx.insert(careItems).values(values).returning();
    if (access.length > 0) await tx.insert(careItemAccess).values(access.map((userId) => ({ careItemId: item.id, userId })));
    if (restricted) await writeAudit(tx, actor, "care_item.restrict", "care_item", item.id, { restricted: true, restrictedShowsCarer: item.restrictedShowsCarer, accessCount: access.length });
    return item;
  });
}

export type CareItemFilter = {
  /** active: new, open or paused and due back. paused: paused and not yet due back. */
  status?: unknown;
  sfContactId?: unknown;
  outsidePersonId?: unknown;
  /** The Chicago day "active" is judged on; today when omitted. */
  today?: unknown;
  /** Record the reads of restricted items (default). A caller that filters the rows further audits what it keeps itself. */
  audit?: boolean;
};

function personWhere(filter: { sfContactId?: unknown; outsidePersonId?: unknown }): SQL[] {
  const where: SQL[] = [];
  if (filter.sfContactId !== undefined) where.push(eq(careItems.sfContactId, contactIdField(filter.sfContactId)));
  if (filter.outsidePersonId !== undefined) where.push(eq(careItems.outsidePersonId, uuidField(filter.outsidePersonId, "outsidePersonId")));
  return where;
}

/** The care items the actor fully sees. Restricted items they may see only as a stub are in listCareItemStubs. */
export async function listCareItems(db: Db, actor: Actor, filter: CareItemFilter = {}): Promise<CareItem[]> {
  const where: SQL[] = [careItemVisibleWhere(actor), ...personWhere(filter)];
  if (filter.status !== undefined) {
    const day = filter.today === undefined ? today() : dateField(filter.today, "today");
    const status = oneOf(filter.status, "status", ["active", "paused", "closed"] as const);
    where.push(status === "active" ? activeWhere(day) : status === "paused" ? pausedWhere(day) : eq(careItems.status, "closed"));
  }
  const items = await db
    .select()
    .from(careItems)
    .where(and(...where))
    .orderBy(desc(careItems.createdAt));
  if (filter.audit !== false) await auditRestrictedReads(db, actor, items);
  return items;
}

/**
 * Restricted items in someone else's care that the actor may know of but not read.
 * Closed items are left out; a pause is not, so the stub does not show when one begins or ends.
 */
export async function listCareItemStubs(db: Db, actor: Actor, filter: { sfContactId?: unknown; outsidePersonId?: unknown } = {}): Promise<CareItemStub[]> {
  const rows = await db
    .select({ id: careItems.id, sfContactId: careItems.sfContactId, outsidePersonId: careItems.outsidePersonId, displayName: careItems.displayName, ownerUserId: careItems.ownerUserId, name: users.name, email: users.email })
    .from(careItems)
    .innerJoin(users, eq(users.id, careItems.ownerUserId))
    // A stub disappears when its item closes, which tells its viewers that much. Accepted.
    .where(and(careItemStubWhere(actor), ne(careItems.status, "closed"), ...personWhere(filter)))
    .orderBy(desc(careItems.createdAt));
  return rows.map(({ name, email, ...r }) => ({ ...r, restricted: true as const, ownerName: name ?? email }));
}

export async function getCareItem(db: Db, actor: Actor, id: unknown): Promise<CareItem> {
  return loadVisibleCareItem(db, actor, id);
}

/** The user ids named on a restricted item, for someone who fully sees it. */
export async function listCareItemAccess(db: Db, actor: Actor, id: unknown): Promise<string[]> {
  const item = await loadVisibleCareItem(db, actor, id);
  const rows = await db.select({ userId: careItemAccess.userId }).from(careItemAccess).where(eq(careItemAccess.careItemId, item.id));
  return rows.map((r) => r.userId);
}

export type CareItemPatch = {
  category?: unknown;
  displayName?: unknown;
  ownerUserId?: unknown;
  visibility?: unknown;
  summary?: unknown;
  location?: unknown;
  learnedFrom?: unknown;
  restricted?: unknown;
  restrictedShowsCarer?: unknown;
  /** Replaces the list of clergy named on a restricted item. */
  accessUserIds?: unknown;
};

/**
 * Change a care item. Clergy level who fully see it only. Restricted,
 * restrictedShowsCarer, the access list and the owner of a restricted item are
 * changed only by its owner as it stands before this change: a named colleague
 * cannot, and no one takes a colleague's item and restricts it in one step.
 */
export async function updateCareItem(db: Db, actor: Actor, id: unknown, patch: CareItemPatch): Promise<CareItem> {
  const item = await loadVisibleCareItem(db, actor, id);
  if (!canManageCareItems(actor)) deny();
  const set: Partial<typeof careItems.$inferInsert> = {};
  if (patch.category !== undefined) set.category = oneOf(patch.category, "category", CARE_CATEGORIES);
  if (patch.displayName !== undefined) set.displayName = text(patch.displayName, "displayName", 200);
  if (patch.visibility !== undefined) set.visibility = oneOf(patch.visibility, "visibility", VISIBILITIES);
  if (patch.ownerUserId !== undefined) set.ownerUserId = uuidField(patch.ownerUserId, "ownerUserId");
  if (patch.summary !== undefined) set.summary = optionalText(patch.summary, "summary", SUMMARY_MAX);
  if (patch.location !== undefined) set.location = optionalText(patch.location, "location", SHORT_MAX);
  if (patch.learnedFrom !== undefined) set.learnedFrom = optionalText(patch.learnedFrom, "learnedFrom", SHORT_MAX);
  if (item.notesPurgedAt && (set.summary || set.location || set.learnedFrom)) set.notesPurgedAt = null;
  const restricted = optionalBool(patch.restricted, "restricted");
  const showsCarer = optionalBool(patch.restrictedShowsCarer, "restrictedShowsCarer");
  if (restricted !== undefined) set.restricted = restricted;
  // A restricted item carries no line for Mitzvah Corps: it is cleared the moment the item is restricted.
  if (restricted === true && item.corpsNote) set.corpsNote = null;
  if (showsCarer !== undefined) set.restrictedShowsCarer = showsCarer;

  const handsOnRestricted = item.restricted && set.ownerUserId !== undefined && set.ownerUserId !== item.ownerUserId;
  if ((restricted !== undefined || showsCarer !== undefined || patch.accessUserIds !== undefined || handsOnRestricted) && !canChangeRestriction(actor, item)) deny();

  const next = { ownerUserId: set.ownerUserId ?? item.ownerUserId, visibility: set.visibility ?? item.visibility, restricted: set.restricted ?? item.restricted };
  if (next.restricted && next.visibility !== "clergy") throw new InvalidInput(set.visibility !== undefined ? "visibility" : "restricted");
  if (set.ownerUserId !== undefined || set.visibility !== undefined || set.restricted !== undefined) await assertAssignable(db, next.ownerUserId, next.visibility, next.restricted);
  const access = patch.accessUserIds === undefined ? null : await accessList(db, patch.accessUserIds, next.ownerUserId);
  if (access && access.length > 0 && !next.restricted) throw new InvalidInput("accessUserIds");
  if (Object.keys(set).length === 0 && access === null) return item;

  const restrictionChanged = restricted !== undefined || showsCarer !== undefined || access !== null;
  return db.transaction(async (tx) => {
    const row = Object.keys(set).length ? (await tx.update(careItems).set(set).where(eq(careItems.id, item.id)).returning())[0] : item;
    // The list is replaced when given, and cleared when the item stops being restricted.
    if (access !== null || !next.restricted) await tx.delete(careItemAccess).where(eq(careItemAccess.careItemId, item.id));
    if (access?.length) await tx.insert(careItemAccess).values(access.map((userId) => ({ careItemId: item.id, userId })));
    if (next.restricted) await releaseHiddenFollowUps(tx, item.id, next.ownerUserId);
    if (restrictionChanged) {
      const named = await tx.select({ userId: careItemAccess.userId }).from(careItemAccess).where(eq(careItemAccess.careItemId, item.id));
      await writeAudit(tx, actor, "care_item.restrict", "care_item", item.id, { restricted: row.restricted, restrictedShowsCarer: row.restrictedShowsCarer, accessCount: named.length });
    }
    if (next.ownerUserId !== item.ownerUserId) {
      await writeAudit(tx, actor, "care_item.reassign", "care_item", item.id, { ownerUserId: next.ownerUserId, previousOwnerUserId: item.ownerUserId });
    }
    return row;
  });
}

/** A holder who can no longer hold a restricted item, and how many they left. Nothing of the items themselves. */
export type StrandedHolder = { userId: string; name: string; count: number };

/**
 * For the owner role: restricted items whose holder has been deactivated or is no
 * longer clergy, as a count per holder. It covers items that show no carer too, and
 * says nothing of who is in care, the category, or anything else.
 */
export async function listStrandedRestricted(db: Db, actor: Actor): Promise<StrandedHolder[]> {
  if (!canSeeStrandedRestricted(actor)) deny();
  const rows = await db
    .select({ userId: users.id, name: users.name, email: users.email, role: users.role, active: users.active, count: sql<number>`count(*)::int` })
    .from(careItems)
    .innerJoin(users, eq(users.id, careItems.ownerUserId))
    .where(eq(careItems.restricted, true))
    .groupBy(users.id, users.name, users.email, users.role, users.active)
    .orderBy(users.email);
  return rows.filter((row) => canHandOverRestricted(actor, row)).map((row) => ({ userId: row.userId, name: row.name ?? row.email, count: row.count }));
}

/**
 * The blind hand-over: the owner role gives ALL of a departed holder's restricted
 * items to one active clergy member. It never changes restricted or
 * restrictedShowsCarer or the names on an item, the owner role may not choose
 * themselves, and a holder who is still active clergy cannot be handed over at all.
 */
export async function handOverRestrictedItems(db: Db, actor: Actor, fromUserId: unknown, toUserId: unknown): Promise<{ count: number }> {
  if (!canSeeStrandedRestricted(actor)) deny();
  const from = uuidField(fromUserId, "fromUserId");
  const to = uuidField(toUserId, "toUserId");
  if (to === actor.id || to === from) throw new InvalidInput("toUserId");
  const [holder] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, from)).limit(1);
  if (!holder) throw new InvalidInput("fromUserId");
  if (!canHandOverRestricted(actor, holder)) deny();
  const [next] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, to)).limit(1);
  if (!next || !canHoldRestricted(next)) throw new InvalidInput("toUserId");
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(careItems)
      .set({ ownerUserId: to })
      .where(and(eq(careItems.restricted, true), eq(careItems.ownerUserId, from)))
      .returning({ id: careItems.id });
    for (const { id } of moved) {
      await tx.delete(careItemAccess).where(and(eq(careItemAccess.careItemId, id), eq(careItemAccess.userId, to)));
      await releaseHiddenFollowUps(tx, id, to);
      await writeAudit(tx, actor, "care_item.hand_over", "care_item", id, { ownerUserId: to, previousOwnerUserId: from });
    }
    return { count: moved.length };
  });
}

/** Close an item. Its journeys end with it: their steps still to do are removed, the done ones and every other follow-up stay. */
export async function closeCareItem(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<CareItem> {
  const item = await loadVisibleCareItem(db, actor, id);
  if (!canManageCareItems(actor)) deny();
  return db.transaction(async (tx) => {
    const [row] = await tx.update(careItems).set({ status: "closed", closedAt: now, pausedUntil: null }).where(eq(careItems.id, item.id)).returning();
    for (const journeyId of await endJourneysForItem(tx, item.id, actor.id, now)) await writeAudit(tx, actor, "journey.end", "journey", journeyId, { careItemId: item.id });
    return row;
  });
}

/** Mark an item's notes "keep" so the retention job never clears them, or take the mark off. Clergy level who fully see it. Audited. */
export async function setKeepNotes(db: Db, actor: Actor, id: unknown, keep: unknown, now: Date = new Date()): Promise<CareItem> {
  const { item, access } = await loadVisibleCareItemAccess(db, actor, id);
  if (!canSetKeepNotes(actor, access)) deny();
  if (typeof keep !== "boolean") throw new InvalidInput("keepNotes");
  if (item.keepNotes === keep) return item;
  return db.transaction(async (tx) => {
    // Switching "keep" off gives the notes 30 more days, even when their three years are already up (src/server/daily/retention.ts).
    const [row] = await tx
      .update(careItems)
      .set({ keepNotes: keep, notesUnkeptAt: keep ? null : now })
      .where(eq(careItems.id, item.id))
      .returning();
    await writeAudit(tx, actor, "care_item.keep_notes", "care_item", item.id, { keepNotes: keep });
    return row;
  });
}

export const CORPS_NOTE_MAX = 300;

/**
 * The "For Mitzvah Corps" line: logistics only, 300 characters, on an item the actor fully sees that is NOT
 * restricted (refused otherwise: a restricted item has no such line). Audited with ids only; the text never is.
 */
export async function setCorpsNote(db: Db, actor: Actor, id: unknown, note: unknown): Promise<CareItem> {
  const { item, access } = await loadVisibleCareItemAccess(db, actor, id);
  if (!canSetCorpsNote(actor, access)) deny();
  const next = optionalText(typeof note === "string" ? note.replace(/\s+/g, " ") : note, "corpsNote", CORPS_NOTE_MAX);
  if ((item.corpsNote ?? null) === next) return item;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(careItems).set({ corpsNote: next, ...(next && item.notesPurgedAt ? { notesPurgedAt: null } : {}) }).where(eq(careItems.id, item.id)).returning();
    await writeAudit(tx, actor, "care_item.corps_note", "care_item", item.id, { careItemId: item.id });
    return row;
  });
}

export async function reopenCareItem(db: Db, actor: Actor, id: unknown): Promise<CareItem> {
  // A reopened item is live again: if its notes were cleared, the rule starts over from its next close.
  return setStatus(db, actor, id, { status: "open", closedAt: null, pausedUntil: null, notesPurgedAt: null });
}

/** Set an item aside until a later day. It leaves Today and the care list, and returns on that day by itself. */
export async function pauseCareItem(db: Db, actor: Actor, id: unknown, until: unknown, day: string = today()): Promise<CareItem> {
  const pausedUntil = dateField(until, "pausedUntil");
  if (pausedUntil <= day) throw new InvalidInput("pausedUntil");
  return setStatus(db, actor, id, { status: "paused", pausedUntil }, (item) => item.status !== "closed");
}

/** Bring a paused item back before its date. */
export async function resumeCareItem(db: Db, actor: Actor, id: unknown): Promise<CareItem> {
  return setStatus(db, actor, id, { status: "open", pausedUntil: null }, (item) => item.status === "paused");
}

async function setStatus(db: Db, actor: Actor, id: unknown, set: Partial<typeof careItems.$inferInsert>, allowed: (item: CareItem) => boolean = () => true): Promise<CareItem> {
  const item = await loadVisibleCareItem(db, actor, id);
  if (!canManageCareItems(actor)) deny();
  if (!allowed(item)) throw new InvalidInput("status");
  const [row] = await db.update(careItems).set(set).where(eq(careItems.id, item.id)).returning();
  return row;
}

/**
 * The first contact makes a new item open: one logged against the item, or against
 * its person while it is new. By person it reaches only the items the actor fully
 * sees, so a contact never changes a restricted item its author cannot see.
 */
export async function openOnFirstContact(db: Db, actor: Actor, target: { careItemId: string } | { sfContactId: string | null; outsidePersonId: string | null }): Promise<void> {
  if ("careItemId" in target) {
    await db.update(careItems).set({ status: "open" }).where(and(eq(careItems.status, "new"), eq(careItems.id, target.careItemId)));
    return;
  }
  const person = target.sfContactId ? eq(careItems.sfContactId, target.sfContactId) : target.outsidePersonId ? eq(careItems.outsidePersonId, target.outsidePersonId) : null;
  if (!person) return;
  await db.update(careItems).set({ status: "open" }).where(and(eq(careItems.status, "new"), person, careItemVisibleWhere(actor)));
}
