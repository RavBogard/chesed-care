/**
 * The Mi Sheberach list. Owner and clergy manage it (src/server/access/policy.ts); every function
 * here asks that module. A name is read aloud, so it shows to every manager; the link to a care
 * item is returned only when the actor fully sees that item, and the list never carries a care
 * item's category, notes or why. Names are never logged or audited: the audit trail holds ids and
 * enum values only.
 */
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { canAddDirectly, canLinkMiSheberachToCareItem, canManageMiSheberach, canSeeMiSheberachCareLink, careItemVisibleWhere, deny, namedOn, type Actor } from "@/server/access/policy";
import { writeAudit, writeSystemAudit } from "@/server/care/audit";
import { loadVisibleCareItemAccess } from "@/server/care/care-items";
import { contactIdField, InvalidInput, NotFound, optionalText, uuidField, uuidOrNotFound } from "@/server/care/validate";
import { careItems, miSheberachEntries, outsidePeople } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { ASKED_MAX, DATED_DAYS, expiresOn, hasUnsafeChars, NAME_MAX, nameKey } from "./line";

export { expiresOn };
export type Entry = typeof miSheberachEntries.$inferSelect;
export type EntryKind = Entry["kind"];
export type EndReason = NonNullable<Entry["endedReason"]>;
/** The reasons clergy choose when they end an entry themselves. */
export const CLERGY_END_REASONS = ["removed_by_clergy", "recovered", "died", "asked_to_be_removed"] as const satisfies readonly EndReason[];

/** A request that cannot be added: the person asked not to be listed. Clergy may override on the add form. */
export class MiSheberachBarred extends Error {
  constructor() {
    super("Asked not to be listed");
    this.name = "MiSheberachBarred";
  }
}

/** The prompt starts this many days before a dated entry comes off. */
export const PROMPT_DAYS = 7;


/**
 * One line of free text for the packet: line breaks and tabs become spaces, asterisks (the packet's marker)
 * go, and anything that never belongs in a name is refused (controls, bidirectional and zero-width marks,
 * private-use characters, unpaired surrogates).
 */
function oneLine(v: unknown, field: string, max: number, required: boolean): string | null {
  const raw = optionalText(v, field, max * 2);
  if (raw === null) {
    if (required) throw new InvalidInput(field);
    return null;
  }
  if (hasUnsafeChars(raw)) throw new InvalidInput(field);
  const s = raw.replace(/[\r\n\t*]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > max) throw new InvalidInput(field);
  return s;
}

/** A name as read aloud: parentheses would break the packet's line, so they are refused. */
function nameField(v: unknown): string {
  const name = oneLine(v, "name", NAME_MAX, true)!;
  if (/[()]/.test(name) || nameKey(name) === "") throw new InvalidInput("name");
  return name;
}

// ─── reading ─────────────────────────────────────────────────────────────────────────

export type EntryView = {
  id: string;
  name: string;
  askedBy: string | null;
  dateAdded: string;
  kind: EntryKind;
  consent: Entry["consent"];
  source: Entry["source"];
  specialRequest: boolean;
  needsReview: boolean;
  /** The day a dated entry comes off; null for a standing one. */
  expiresOn: string | null;
  expiringSoon: boolean;
  sfContactId: string | null;
  outsidePersonId: string | null;
  /** Only when the actor fully sees that care item; otherwise null, whatever the entry holds. */
  careItemId: string | null;
  endedAt: Date | null;
  endedReason: EndReason | null;
};

function viewOf(row: Entry, careItemId: string | null, today: string): EntryView {
  const exp = row.kind === "dated" ? expiresOn(row.dateAdded, row.keepUntil) : null;
  return {
    id: row.id,
    name: row.name,
    askedBy: row.askedBy,
    dateAdded: row.dateAdded,
    kind: row.kind,
    consent: row.consent,
    source: row.source,
    specialRequest: row.specialRequest,
    needsReview: row.needsReview,
    expiresOn: exp,
    expiringSoon: exp !== null && row.endedAt === null && today >= addDays(exp, -PROMPT_DAYS) && today < exp,
    sfContactId: row.sfContactId,
    outsidePersonId: row.outsidePersonId,
    careItemId,
    endedAt: row.endedAt,
    endedReason: row.endedReason,
  };
}

/** Rows with the care item link already judged for this actor. */
async function rowsFor(db: Db, actor: Actor, where: ReturnType<typeof and>, today: string, order: "list" | "ended"): Promise<EntryView[]> {
  const rows = await db
    .select({
      e: miSheberachEntries,
      item: { ownerUserId: careItems.ownerUserId, restricted: careItems.restricted, visibility: careItems.visibility, restrictedShowsCarer: careItems.restrictedShowsCarer },
      named: namedOn(actor),
    })
    .from(miSheberachEntries)
    .leftJoin(careItems, eq(careItems.id, miSheberachEntries.careItemId))
    .where(where)
    .orderBy(...(order === "ended" ? [desc(miSheberachEntries.endedAt)] : [desc(miSheberachEntries.dateAdded), desc(miSheberachEntries.createdAt)]));
  return rows.map((r) => {
    const access = r.e.careItemId && r.item ? { ...r.item, named: r.named === true } : null;
    return viewOf(r.e, canSeeMiSheberachCareLink(actor, access) ? r.e.careItemId : null, today);
  });
}

/** Dated names newest first, then the standing ones: the order they are read and written. */
export function readingOrder(entries: EntryView[]): EntryView[] {
  return [...entries.filter((e) => e.kind === "dated"), ...entries.filter((e) => e.kind === "standing")];
}

export type ListView = { today: string; current: EntryView[]; ended: EntryView[] };

/** The current list as it will be read, and what ended in the last 12 months. */
export async function listEntries(db: Db, actor: Actor, now: Date = new Date()): Promise<ListView> {
  if (!canManageMiSheberach(actor)) deny();
  const today = chicagoToday(now);
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000);
  const [current, ended] = await Promise.all([
    rowsFor(db, actor, and(isNull(miSheberachEntries.endedAt)), today, "list"),
    rowsFor(db, actor, and(gte(miSheberachEntries.endedAt, yearAgo)), today, "ended"),
  ]);
  return { today, current: readingOrder(current), ended };
}

export type PersonRef = { sfContactId?: string | null; outsidePersonId?: string | null };

/** The live entries for a person (a member by Contact Id, or an outside person): for "On the Mi Sheberach list since ...". No care item is involved. */
export async function liveEntriesForPerson(db: Db, actor: Actor, ref: PersonRef, now: Date = new Date()): Promise<EntryView[]> {
  if (!canManageMiSheberach(actor)) return [];
  const who = ref.sfContactId ? eq(miSheberachEntries.sfContactId, ref.sfContactId) : ref.outsidePersonId ? eq(miSheberachEntries.outsidePersonId, ref.outsidePersonId) : null;
  if (!who) return [];
  return rowsFor(db, actor, and(isNull(miSheberachEntries.endedAt), who), chicagoToday(now), "list");
}

/** The live entries linked to these care items, only for items the actor fully sees (the SQL twin of the policy). */
export async function liveEntriesForCareItems(db: Db, actor: Actor, careItemIds: string[], now: Date = new Date()): Promise<EntryView[]> {
  if (!canManageMiSheberach(actor) || careItemIds.length === 0) return [];
  const seen = await db.select({ id: careItems.id }).from(careItems).where(and(inArray(careItems.id, careItemIds), careItemVisibleWhere(actor)));
  if (seen.length === 0) return [];
  return rowsFor(db, actor, and(isNull(miSheberachEntries.endedAt), inArray(miSheberachEntries.careItemId, seen.map((s) => s.id))), chicagoToday(now), "list");
}

export type Prompt = { id: string; name: string; expiresOn: string };

/** Dated names that come off within a week: the quiet "still needed?" prompt on Today. */
export async function listPrompts(db: Db, actor: Actor, now: Date = new Date()): Promise<Prompt[]> {
  if (!canManageMiSheberach(actor)) return [];
  const today = chicagoToday(now);
  const rows = await db
    .select({ id: miSheberachEntries.id, name: miSheberachEntries.name, dateAdded: miSheberachEntries.dateAdded, keepUntil: miSheberachEntries.keepUntil })
    .from(miSheberachEntries)
    .where(and(isNull(miSheberachEntries.endedAt), eq(miSheberachEntries.kind, "dated")));
  return rows
    .map((r) => ({ id: r.id, name: r.name, expiresOn: expiresOn(r.dateAdded, r.keepUntil) }))
    .filter((r) => today >= addDays(r.expiresOn, -PROMPT_DAYS) && today < r.expiresOn)
    .sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : 1));
}

// ─── writing ─────────────────────────────────────────────────────────────────────────

export type AddInput = {
  name: unknown;
  kind?: unknown;
  askedBy?: unknown;
  sfContactId?: unknown;
  outsidePersonId?: unknown;
  careItemId?: unknown;
  specialRequest?: unknown;
  consent?: unknown;
  /** Clergy have checked with the person: add even though they once asked not to be listed. */
  override?: unknown;
};
export type AddOptions = { source?: Entry["source"]; now?: Date };

const KINDS = ["dated", "standing"] as const;
const isKind = (v: unknown): v is EntryKind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

/** Whether someone with this name key once asked not to be listed. */
export async function isBarred(db: Db, key: string): Promise<boolean> {
  const [row] = await db.select({ id: miSheberachEntries.id }).from(miSheberachEntries).where(and(eq(miSheberachEntries.nameKey, key), eq(miSheberachEntries.consent, "asked_not_listed"))).limit(1);
  return !!row;
}

/**
 * Put a name on the list at once. A requested name is "not yet confirmed" for clergy to follow
 * up. The same name already on the list returns that entry. A name whose person asked not to be
 * listed is refused (MiSheberachBarred) unless clergy pass `override`. A link to a care item
 * needs full sight of that item.
 */
export async function addEntry(db: Db, actor: Actor, input: AddInput, opts: AddOptions = {}): Promise<{ entry: Entry; created: boolean }> {
  if (!canManageMiSheberach(actor)) deny();
  return writeEntry(db, actor, input, opts);
}

/**
 * Staff and Mitzvah Corps leads add a name directly: the name and who asked, nothing else (no link to a person or a
 * care item, always "not yet confirmed", never over a person's no). They learn only whether it went on: "barred" means a
 * rabbi must decide, and the caller sends it to the Inbox without saying why.
 */
export async function addRequestedName(db: Db, actor: Actor, input: { name: unknown; askedBy?: unknown }, now: Date = new Date()): Promise<"added" | "already" | "barred"> {
  if (!canAddDirectly(actor)) deny();
  try {
    return (await writeEntry(db, actor, { name: input.name, askedBy: input.askedBy }, { now })).created ? "added" : "already";
  } catch (error) {
    if (error instanceof MiSheberachBarred) return "barred";
    throw error;
  }
}

async function writeEntry(db: Db, actor: Actor, input: AddInput, opts: AddOptions): Promise<{ entry: Entry; created: boolean }> {
  const now = opts.now ?? new Date();
  const name = nameField(input.name);
  const key = nameKey(name);
  const kind = input.kind === undefined || input.kind === "" ? "dated" : isKind(input.kind) ? input.kind : (() => { throw new InvalidInput("kind"); })();
  const consent = input.consent === undefined || input.consent === "" ? "not_confirmed" : input.consent === "confirmed" || input.consent === "not_confirmed" ? input.consent : (() => { throw new InvalidInput("consent"); })();
  const askedBy = oneLine(input.askedBy, "askedBy", ASKED_MAX, false);
  const sfContactId = input.sfContactId ? contactIdField(input.sfContactId) : null;
  const outsidePersonId = input.outsidePersonId ? uuidField(input.outsidePersonId, "outsidePersonId") : null;
  if (sfContactId && outsidePersonId) throw new InvalidInput("outsidePersonId");
  let careItemId: string | null = null;
  if (input.careItemId) {
    const { item, access } = await loadVisibleCareItemAccess(db, actor, input.careItemId);
    if (!canLinkMiSheberachToCareItem(actor, access)) deny();
    careItemId = item.id;
  }
  if (outsidePersonId) {
    const [p] = await db.select({ id: outsidePeople.id }).from(outsidePeople).where(eq(outsidePeople.id, outsidePersonId)).limit(1);
    if (!p) throw new InvalidInput("outsidePersonId");
  }
  const [live] = await db.select().from(miSheberachEntries).where(and(eq(miSheberachEntries.nameKey, key), isNull(miSheberachEntries.endedAt))).limit(1);
  if (live) return { entry: live, created: false };
  if (input.override !== true && (await isBarred(db, key))) throw new MiSheberachBarred();
  const source = opts.source ?? "app";
  const [entry] = await db
    .insert(miSheberachEntries)
    .values({
      name,
      nameKey: key,
      sfContactId,
      outsidePersonId,
      careItemId,
      askedBy,
      dateAdded: chicagoToday(now),
      kind,
      consent,
      source,
      specialRequest: input.specialRequest === true,
      createdBy: actor.id,
    })
    .returning();
  await writeAudit(db, actor, "mi_sheberach.add", "mi_sheberach_entry", entry.id, { entryKind: kind, consent, source });
  return { entry, created: true };
}

async function loadLive(db: Db, id: unknown): Promise<Entry> {
  const [row] = await db.select().from(miSheberachEntries).where(eq(miSheberachEntries.id, uuidOrNotFound(id))).limit(1);
  if (!row) throw new NotFound();
  return row;
}

export type UpdateInput = { name?: unknown; kind?: unknown; askedBy?: unknown; consent?: unknown; specialRequest?: unknown; sfContactId?: unknown; outsidePersonId?: unknown; careItemId?: unknown };

/** Change a live entry. Saying the person asked not to be listed ends it (reason: asked to be removed). Any edit clears the packet's "look at this" flag. */
export async function updateEntry(db: Db, actor: Actor, id: unknown, patch: UpdateInput, now: Date = new Date()): Promise<Entry> {
  if (!canManageMiSheberach(actor)) deny();
  const row = await loadLive(db, id);
  if (row.endedAt) throw new InvalidInput("status");
  const set: Partial<typeof miSheberachEntries.$inferInsert> = { needsReview: false };
  if (patch.name !== undefined) {
    set.name = nameField(patch.name);
    set.nameKey = nameKey(set.name);
    if (set.nameKey !== row.nameKey) {
      // Renaming an entry to the name of someone who asked not to be listed is the same as adding them.
      if (await isBarred(db, set.nameKey)) throw new MiSheberachBarred();
      const [clash] = await db.select({ id: miSheberachEntries.id }).from(miSheberachEntries).where(and(eq(miSheberachEntries.nameKey, set.nameKey), isNull(miSheberachEntries.endedAt), ne(miSheberachEntries.id, row.id))).limit(1);
      if (clash) throw new InvalidInput("name");
    }
  }
  if (patch.kind !== undefined) {
    if (!isKind(patch.kind)) throw new InvalidInput("kind");
    set.kind = patch.kind;
  }
  if (patch.askedBy !== undefined) set.askedBy = oneLine(patch.askedBy, "askedBy", ASKED_MAX, false);
  if (patch.specialRequest !== undefined) set.specialRequest = patch.specialRequest === true;
  if (patch.sfContactId !== undefined) set.sfContactId = patch.sfContactId ? contactIdField(patch.sfContactId) : null;
  if (patch.outsidePersonId !== undefined) set.outsidePersonId = patch.outsidePersonId ? uuidField(patch.outsidePersonId, "outsidePersonId") : null;
  if (set.sfContactId && set.outsidePersonId) throw new InvalidInput("outsidePersonId");
  if (patch.careItemId !== undefined) {
    if (patch.careItemId) {
      const { item, access } = await loadVisibleCareItemAccess(db, actor, patch.careItemId);
      if (!canLinkMiSheberachToCareItem(actor, access)) deny();
      set.careItemId = item.id;
    } else {
      // Taking a link off one cannot fully see would be a way to learn it exists: only those who see the item clear it.
      if (row.careItemId) await loadVisibleCareItemAccess(db, actor, row.careItemId);
      set.careItemId = null;
    }
  }
  if (patch.consent !== undefined) {
    if (patch.consent === "asked_not_listed") return endWith(db, actor, row, "asked_to_be_removed", now, { ...set, consent: "asked_not_listed" });
    if (patch.consent !== "confirmed" && patch.consent !== "not_confirmed") throw new InvalidInput("consent");
    set.consent = patch.consent;
  }
  const [updated] = await db.update(miSheberachEntries).set(set).where(eq(miSheberachEntries.id, row.id)).returning();
  await writeAudit(db, actor, "mi_sheberach.update", "mi_sheberach_entry", row.id, { entryKind: updated.kind, consent: updated.consent });
  return updated;
}

async function endWith(db: Db, actor: Actor, row: Entry, reason: EndReason, now: Date, extra: Partial<typeof miSheberachEntries.$inferInsert> = {}): Promise<Entry> {
  const [ended] = await db
    .update(miSheberachEntries)
    .set({ ...extra, endedAt: now, endedReason: reason, endedBy: actor.id, needsReview: false, ...(reason === "asked_to_be_removed" ? { consent: "asked_not_listed" as const } : {}) })
    .where(and(eq(miSheberachEntries.id, row.id), isNull(miSheberachEntries.endedAt)))
    .returning();
  if (!ended) throw new InvalidInput("status");
  await writeAudit(db, actor, "mi_sheberach.end", "mi_sheberach_entry", row.id, { reason });
  return ended;
}

/** End an entry with a reason clergy chose. "Asked to be removed" also records that the person asked not to be listed, so nothing re-adds the name without a clergy override. */
export async function endEntry(db: Db, actor: Actor, id: unknown, reason: unknown, now: Date = new Date()): Promise<Entry> {
  if (!canManageMiSheberach(actor)) deny();
  if (typeof reason !== "string" || !(CLERGY_END_REASONS as readonly string[]).includes(reason)) throw new InvalidInput("reason");
  return endWith(db, actor, await loadLive(db, id), reason as EndReason, now);
}

export const RENEWALS = ["keep", "standing", "let_off"] as const;

/** The one-tap answers to "still needed?": 120 more days (the date added becomes today, as the packet's date is what counts), until further notice, or let it come off. */
export async function renewEntry(db: Db, actor: Actor, id: unknown, choice: unknown, now: Date = new Date()): Promise<Entry> {
  if (!canManageMiSheberach(actor)) deny();
  if (typeof choice !== "string" || !(RENEWALS as readonly string[]).includes(choice)) throw new InvalidInput("choice");
  const row = await loadLive(db, id);
  if (row.endedAt) throw new InvalidInput("status");
  if (choice === "let_off") return endWith(db, actor, row, "expired", now);
  const set = choice === "keep" ? { dateAdded: chicagoToday(now), kind: "dated" as const, keepUntil: null } : { kind: "standing" as const, keepUntil: null };
  const [updated] = await db.update(miSheberachEntries).set({ ...set, needsReview: false }).where(eq(miSheberachEntries.id, row.id)).returning();
  await writeAudit(db, actor, "mi_sheberach.renew", "mi_sheberach_entry", row.id, { entryKind: updated.kind, reason: choice });
  return updated;
}

/** The daily task: dated entries 120 days old come off. Counts only; the sync then takes them out of the packet. */
export async function expireDueEntries(db: Db, now: Date): Promise<{ expired: number }> {
  const today = chicagoToday(now);
  const due = await db
    .update(miSheberachEntries)
    .set({ endedAt: now, endedReason: "expired" })
    .where(and(isNull(miSheberachEntries.endedAt), eq(miSheberachEntries.kind, "dated"), sql`${miSheberachEntries.dateAdded} <= (${today}::date - ${DATED_DAYS}::int)`, sql`(${miSheberachEntries.keepUntil} is null or ${miSheberachEntries.keepUntil} <= ${today}::date)`))
    .returning({ id: miSheberachEntries.id });
  for (const { id } of due) await writeSystemAudit(db, "mi_sheberach.end", "mi_sheberach_entry", id, { reason: "expired" });
  return { expired: due.length };
}
