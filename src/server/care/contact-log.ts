/**
 * The contact log. Note text is pastoral: it is never logged or audited, and it
 * leaves this module only through redactEntry (src/server/access/policy.ts).
 */
import { and, desc, eq, type SQL } from "drizzle-orm";
import { canCreateContactEntry, canEditContactEntry, canSeeContactEntry, contactEntryVisibleWhere, deny, namedOn, redactEntry, type Actor } from "@/server/access/policy";
import { careItems, contactLog, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { auditRestrictedReadsByItem, writeAudit } from "./audit";
import { loadVisibleCareItemAccess, markNotesWritten, openOnFirstContact } from "./care-items";
import { personSubject, type PersonSubjectInput } from "./outside-people";
import { contactIdField, InvalidInput, instantField, NotFound, oneOf, optionalBool, optionalText, uuidField, uuidOrNotFound } from "./validate";

const KINDS = ["call", "visit", "text", "other"] as const;
export const CONTACT_OUTCOMES = ["spoke", "no_answer", "left_message", "visited", "texted"] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];
const NOTE_MAX = 5000;

type Row = typeof contactLog.$inferSelect;
export type ContactEntry = Row & { authorName: string | null; noteHidden: boolean };

export function outcomeField(v: unknown): ContactOutcome | null {
  return v === undefined || v === null || v === "" ? null : oneOf(v, "outcome", CONTACT_OUTCOMES);
}

/**
 * Insert an entry the caller has already checked against the policy. Unless told
 * otherwise it counts as contact with the person, which makes a new care item open.
 */
export async function recordContact(db: Db, actor: Actor, values: Omit<typeof contactLog.$inferInsert, "authorUserId">, opts: { countsAsContact?: boolean } = {}): Promise<Row> {
  const [row] = await db
    .insert(contactLog)
    .values({ ...values, authorUserId: actor.id })
    .returning();
  if (opts.countsAsContact !== false) await openOnFirstContact(db, actor, row.careItemId ? { careItemId: row.careItemId } : { sfContactId: row.sfContactId, outsidePersonId: row.outsidePersonId });
  if (row.careItemId && row.note) await markNotesWritten(db, row.careItemId);
  return row;
}

export async function createContactEntry(
  db: Db,
  actor: Actor,
  input: PersonSubjectInput & { careItemId?: unknown; kind: unknown; occurredAt: unknown; note?: unknown; private?: unknown; outcome?: unknown },
): Promise<ContactEntry> {
  const loaded = input.careItemId === undefined || input.careItemId === null ? null : await loadVisibleCareItemAccess(db, actor, input.careItemId);
  if (!canCreateContactEntry(actor, loaded?.access ?? null)) deny();
  const careItem = loaded?.item ?? null;
  if (careItem?.status === "closed") throw new InvalidInput("careItemId");
  const person = careItem
    ? { sfContactId: careItem.sfContactId, outsidePersonId: careItem.outsidePersonId, sfAccountId: careItem.sfAccountId, displayName: careItem.displayName }
    : await personSubject(db, actor, input, true);
  const values = {
    ...person,
    displayName: person.displayName!,
    careItemId: careItem?.id ?? null,
    kind: oneOf(input.kind, "kind", KINDS),
    outcome: outcomeField(input.outcome),
    occurredAt: instantField(input.occurredAt, "occurredAt"),
    note: optionalText(input.note, "note", NOTE_MAX),
    private: optionalBool(input.private, "private") === true,
  };
  const row = await db.transaction((tx) => recordContact(tx, actor, values));
  return redactEntry(actor, { ...row, authorName: actor.name });
}

/** Entries for a person or a care item (or all the actor may see), newest first, redacted for the actor. */
export async function listContactEntries(db: Db, actor: Actor, filter: { sfContactId?: unknown; outsidePersonId?: unknown; careItemId?: unknown; limit?: number } = {}): Promise<ContactEntry[]> {
  const where: SQL[] = [contactEntryVisibleWhere(actor)];
  if (filter.sfContactId !== undefined) where.push(eq(contactLog.sfContactId, contactIdField(filter.sfContactId)));
  if (filter.outsidePersonId !== undefined) where.push(eq(contactLog.outsidePersonId, uuidField(filter.outsidePersonId, "outsidePersonId")));
  if (filter.careItemId !== undefined) where.push(eq(contactLog.careItemId, uuidField(filter.careItemId, "careItemId")));
  const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 100)), 500);
  const rows = await db
    .select({ entry: contactLog, authorName: users.name })
    .from(contactLog)
    .innerJoin(users, eq(users.id, contactLog.authorUserId))
    .where(and(...where))
    .orderBy(desc(contactLog.occurredAt))
    .limit(limit);
  await auditRestrictedReadsByItem(db, actor, rows.map((r) => r.entry.careItemId));
  return rows.map((r) => redactEntry(actor, { ...r.entry, authorName: r.authorName }));
}

/** An entry the actor may list, or NotFound (missing, hidden and on a restricted item look the same). */
async function loadVisibleEntry(db: Db, actor: Actor, id: unknown): Promise<Row> {
  const [found] = await db
    .select({ row: contactLog, careItemVisibility: careItems.visibility, itemOwner: careItems.ownerUserId, itemRestricted: careItems.restricted, named: namedOn(actor) })
    .from(contactLog)
    .leftJoin(careItems, eq(careItems.id, contactLog.careItemId))
    .where(eq(contactLog.id, uuidOrNotFound(id)))
    .limit(1);
  if (!found) throw new NotFound();
  const careItem = found.itemOwner === null ? null : { ownerUserId: found.itemOwner, restricted: found.itemRestricted === true, named: found.named === true };
  if (!canSeeContactEntry(actor, { ...found.row, careItemVisibility: found.careItemVisibility, careItem })) throw new NotFound();
  return found.row;
}

/** Only the author may change an entry (kind, time, note, outcome, private flag). */
export async function updateContactEntry(
  db: Db,
  actor: Actor,
  id: unknown,
  patch: { kind?: unknown; occurredAt?: unknown; note?: unknown; private?: unknown; outcome?: unknown },
): Promise<ContactEntry> {
  const row = await loadVisibleEntry(db, actor, id);
  if (!canEditContactEntry(actor, row)) deny();
  const set: Partial<typeof contactLog.$inferInsert> = {};
  if (patch.kind !== undefined) set.kind = oneOf(patch.kind, "kind", KINDS);
  if (patch.occurredAt !== undefined) set.occurredAt = instantField(patch.occurredAt, "occurredAt");
  if (patch.note !== undefined) set.note = optionalText(patch.note, "note", NOTE_MAX);
  if (patch.outcome !== undefined) set.outcome = outcomeField(patch.outcome);
  const priv = optionalBool(patch.private, "private");
  if (priv !== undefined) set.private = priv;
  const updated = Object.keys(set).length ? (await db.update(contactLog).set(set).where(eq(contactLog.id, row.id)).returning())[0] : row;
  if (updated.careItemId && updated.note && set.note !== undefined) await markNotesWritten(db, updated.careItemId);
  return redactEntry(actor, { ...updated, authorName: actor.name });
}

/** Only the author may delete an entry. The deletion is audited (which entry, never its text). */
export async function deleteContactEntry(db: Db, actor: Actor, id: unknown): Promise<void> {
  const row = await loadVisibleEntry(db, actor, id);
  if (!canEditContactEntry(actor, row)) deny();
  await db.transaction(async (tx) => {
    await tx.delete(contactLog).where(eq(contactLog.id, row.id));
    await writeAudit(tx, actor, "contact.delete", "contact_log", row.id, { careItemId: row.careItemId });
  });
}
