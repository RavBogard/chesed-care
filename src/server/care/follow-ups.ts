import { and, asc, eq, gte, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  canCompleteLeadStep,
  canCreateContactEntry,
  canCreateFollowUp,
  canDeleteFollowUp,
  canEditFollowUp,
  canHoldLeadStep,
  canReassignFollowUp,
  canSeeFollowUp,
  deny,
  followUpVisibleWhere,
  isCareTeam,
  namedOn,
  type Actor,
  type CareItemAccessRow,
  type FollowUpAccessRow,
} from "@/server/access/policy";
import { OUTCOME_KIND } from "@/lib/care-labels";
import { careItems, followUps, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { ensureNextStandingStep, removeLaterStandingSteps } from "@/server/journeys/lifecycle";
import { auditRestrictedReadsByItem, writeAudit } from "./audit";
import { assertCanHoldWorkOn, loadVisibleCareItemAccess, type CareItem } from "./care-items";
import { outcomeField, recordContact } from "./contact-log";
import { personSubject, type PersonSubjectInput } from "./outside-people";
import { contactIdField, dateField, InvalidInput, NotFound, optionalText, text, uuidField, uuidOrNotFound } from "./validate";

export type FollowUp = typeof followUps.$inferSelect;

type Loaded = { row: FollowUp; access: FollowUpAccessRow; careItem: CareItem | null; itemAccess: CareItemAccessRow | null };

/** A follow-up the actor may see, or NotFound (missing, hidden and on a restricted item look the same). */
async function loadVisibleFollowUp(db: Db, actor: Actor, id: unknown): Promise<Loaded> {
  const [found] = await db
    .select({ row: followUps, careItem: careItems, named: namedOn(actor) })
    .from(followUps)
    .leftJoin(careItems, eq(careItems.id, followUps.careItemId))
    .where(eq(followUps.id, uuidOrNotFound(id)))
    .limit(1);
  if (!found) throw new NotFound();
  const { careItem } = found;
  const itemAccess = careItem ? { ownerUserId: careItem.ownerUserId, visibility: careItem.visibility, restricted: careItem.restricted, restrictedShowsCarer: careItem.restrictedShowsCarer, named: found.named === true } : null;
  const access = { ownerUserId: found.row.ownerUserId, careItem: itemAccess, forLead: found.row.forLead };
  if (!canSeeFollowUp(actor, access)) throw new NotFound();
  return { row: found.row, access, careItem, itemAccess };
}

/**
 * A follow-up is about a care item, or about a person (a Salesforce contact or an
 * outside person) directly. Clergy may give it to anyone on the team who can see
 * its subject: a caregiver only on a care item visible to caregivers, and on a
 * restricted item only its owner or the clergy named on it. A caregiver creates
 * one only for themselves, on a care item they can see.
 */
export async function createFollowUp(db: Db, actor: Actor, input: PersonSubjectInput & { careItemId?: unknown; title: unknown; dueDate: unknown; ownerUserId?: unknown }): Promise<FollowUp> {
  const loaded = input.careItemId === undefined || input.careItemId === null ? null : await loadVisibleCareItemAccess(db, actor, input.careItemId);
  const ownerUserId = input.ownerUserId === undefined ? actor.id : uuidField(input.ownerUserId, "ownerUserId");
  if (!canCreateFollowUp(actor, { ownerUserId, careItem: loaded?.access ?? null })) deny();
  const careItem = loaded?.item ?? null;
  if (careItem?.status === "closed") throw new InvalidInput("careItemId");
  await assertCanHoldWorkOn(db, ownerUserId, careItem);
  const person = careItem
    ? { sfContactId: careItem.sfContactId, outsidePersonId: careItem.outsidePersonId, sfAccountId: careItem.sfAccountId, displayName: careItem.displayName }
    : await personSubject(db, actor, input, false);
  const [row] = await db
    .insert(followUps)
    .values({
      careItemId: careItem?.id ?? null,
      ...person,
      title: text(input.title, "title", 200),
      dueDate: dateField(input.dueDate, "dueDate"),
      ownerUserId,
      createdBy: actor.id,
    })
    .returning();
  return row;
}

export async function listFollowUps(
  db: Db,
  actor: Actor,
  filter: { open?: boolean; ownerUserId?: unknown; careItemId?: unknown; sfContactId?: unknown; outsidePersonId?: unknown; dueOnOrBefore?: unknown; audit?: boolean } = {},
): Promise<FollowUp[]> {
  const where: SQL[] = [followUpVisibleWhere(actor)];
  if (filter.open === true) where.push(isNull(followUps.doneAt));
  if (filter.open === false) where.push(isNotNull(followUps.doneAt));
  if (filter.ownerUserId !== undefined) where.push(eq(followUps.ownerUserId, uuidField(filter.ownerUserId, "ownerUserId")));
  if (filter.careItemId !== undefined) where.push(eq(followUps.careItemId, uuidField(filter.careItemId, "careItemId")));
  if (filter.sfContactId !== undefined) where.push(eq(followUps.sfContactId, contactIdField(filter.sfContactId)));
  if (filter.outsidePersonId !== undefined) where.push(eq(followUps.outsidePersonId, uuidField(filter.outsidePersonId, "outsidePersonId")));
  if (filter.dueOnOrBefore !== undefined) where.push(lte(followUps.dueDate, dateField(filter.dueOnOrBefore, "dueOnOrBefore")));
  const rows = await db
    .select()
    .from(followUps)
    .where(and(...where))
    .orderBy(asc(followUps.dueDate), asc(followUps.createdAt));
  if (filter.audit !== false) await auditFollowUpReads(db, actor, rows);
  // A lead gets their own Mitzvah Corps steps here, never which care item made them.
  return isCareTeam(actor) ? rows : rows.map((r) => ({ ...r, careItemId: null, journeyId: null }));
}

/** Follow-ups on a restricted item are read in full by whoever gets them back: record it, once per reader, item and day. */
export async function auditFollowUpReads(db: Db, actor: Actor, rows: Pick<FollowUp, "careItemId">[]): Promise<void> {
  await auditRestrictedReadsByItem(db, actor, rows.map((r) => r.careItemId));
}

/** Change title or due date (owner or clergy), or move it to someone else (clergy only). */
export async function updateFollowUp(db: Db, actor: Actor, id: unknown, patch: { title?: unknown; dueDate?: unknown; ownerUserId?: unknown }): Promise<FollowUp> {
  const { row, access, careItem } = await loadVisibleFollowUp(db, actor, id);
  if (!canEditFollowUp(actor, access)) deny();
  const set: Partial<typeof followUps.$inferInsert> = {};
  if (patch.title !== undefined) set.title = text(patch.title, "title", 200);
  if (patch.dueDate !== undefined) set.dueDate = dateField(patch.dueDate, "dueDate");
  if (patch.ownerUserId !== undefined) {
    const owner = uuidField(patch.ownerUserId, "ownerUserId");
    if (owner !== row.ownerUserId) {
      if (!canReassignFollowUp(actor)) deny();
      // A Mitzvah Corps step may also go to an active lead, never on a restricted item.
      if (!(row.forLead && careItem && (await isLeadFor(db, owner, careItem)))) await assertCanHoldWorkOn(db, owner, careItem);
      set.ownerUserId = owner;
    }
  }
  if (Object.keys(set).length === 0) return row;
  const [updated] = await db.update(followUps).set(set).where(eq(followUps.id, row.id)).returning();
  return updated;
}

/**
 * Mark done ("close"), or reopen with done = false. Marking done with an outcome
 * (spoke, no answer, …) also writes the contact log entry, in the same transaction.
 */
export async function setFollowUpDone(db: Db, actor: Actor, id: unknown, done: boolean, opts: { outcome?: unknown; now?: Date } = {}): Promise<FollowUp> {
  const { row, access, careItem, itemAccess } = await loadVisibleFollowUp(db, actor, id);
  if (!canEditFollowUp(actor, access)) deny();
  const outcome = done ? outcomeField(opts.outcome) : null;
  const now = opts.now ?? new Date();
  // The same rule as logging a contact by hand: a caregiver only against a care item they can see.
  if (outcome && !canCreateContactEntry(actor, itemAccess)) deny();
  const sfContactId = row.sfContactId ?? careItem?.sfContactId ?? null;
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(followUps)
      .set({ doneAt: done ? now : null })
      .where(eq(followUps.id, row.id))
      .returning();
    if (outcome) {
      await recordContact(tx, actor, {
        sfContactId,
        outsidePersonId: sfContactId ? null : (row.outsidePersonId ?? careItem?.outsidePersonId ?? null),
        sfAccountId: row.sfAccountId,
        displayName: careItem?.displayName ?? row.displayName ?? "Name not recorded",
        careItemId: careItem?.id ?? null,
        kind: OUTCOME_KIND[outcome],
        outcome,
        occurredAt: now,
      });
    }
    // A standing check-in's next step is made when the last is done (or skipped: done with no contact logged).
    if (done && row.journeyId) await ensureNextStandingStep(tx, row.journeyId, now);
    // Brought back from done: the next one made meanwhile goes, so a standing check-in never has two open.
    if (!done && row.journeyId) {
      for (const removedId of await removeLaterStandingSteps(tx, row.journeyId, row.id)) {
        await writeAudit(tx, actor, "follow_up.delete", "follow_up", removedId, { careItemId: row.careItemId });
      }
    }
    return updated;
  });
}

async function isLeadFor(db: Db, userId: string, item: CareItem): Promise<boolean> {
  const [user] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
  return !!user && canHoldLeadStep(user, item);
}

/** What a Mitzvah Corps lead sees of a step assigned to them: the person, the step, its date and its logistics. Nothing of the care item. */
export type LeadStep = { id: string; person: string; title: string; dueDate: string; done: boolean; outcomeNote: string | null; mealsHref: string | null; /** The clergy's logistics-only line for Mitzvah Corps, or null. Never from a restricted item. */ corpsNote: string | null };

/** The lead's own Mitzvah Corps steps: those still to do, and those done in the last two weeks. Anyone else gets none. */
export async function listLeadSteps(db: Db, actor: Actor, now: Date = new Date()): Promise<LeadStep[]> {
  if (actor.role !== "lead") return [];
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const rows = await db
    .select({ id: followUps.id, displayName: followUps.displayName, sfContactId: followUps.sfContactId, title: followUps.title, dueDate: followUps.dueDate, doneAt: followUps.doneAt, outcomeNote: followUps.outcomeNote, link: followUps.link, corpsNote: sql<string | null>`case when ${careItems.restricted} then null else ${careItems.corpsNote} end` })
    .from(followUps)
    .leftJoin(careItems, eq(careItems.id, followUps.careItemId))
    .where(and(followUpVisibleWhere(actor), or(isNull(followUps.doneAt), gte(followUps.doneAt, since))))
    .orderBy(asc(followUps.dueDate), asc(followUps.createdAt));
  return rows.map((r) => ({
    id: r.id,
    person: r.displayName ?? "Name not recorded",
    title: r.title,
    dueDate: r.dueDate,
    done: r.doneAt !== null,
    outcomeNote: r.outcomeNote,
    // The household-name search a lead may use, never the care item (a lead never learns of it).
    mealsHref: r.link === "meals" ? (r.sfContactId ? `/meals/new?contact=${r.sfContactId}` : "/meals/new") : null,
    corpsNote: r.corpsNote,
  }));
}

const OUTCOME_NOTE_MAX = 200;

/** A lead marks their own step done, with an optional one-line outcome for the item's owner. */
export async function completeLeadStep(db: Db, actor: Actor, id: unknown, outcomeNote: unknown, now: Date = new Date()): Promise<void> {
  const { row, access } = await loadVisibleFollowUp(db, actor, id);
  if (!canCompleteLeadStep(actor, access)) deny();
  if (row.doneAt) throw new InvalidInput("done");
  const note = optionalText(typeof outcomeNote === "string" ? outcomeNote.replace(/\s+/g, " ") : outcomeNote, "outcomeNote", OUTCOME_NOTE_MAX);
  await db.transaction(async (tx) => {
    // Once only: a second tap (or a race) finds it already done and changes nothing.
    const [updated] = await tx
      .update(followUps)
      .set({ doneAt: now, outcomeNote: note })
      .where(and(eq(followUps.id, row.id), isNull(followUps.doneAt)))
      .returning({ id: followUps.id });
    if (!updated) throw new InvalidInput("done");
    await writeAudit(tx, actor, "follow_up.lead_done", "follow_up", row.id, { careItemId: row.careItemId });
  });
}

/** Delete a follow-up: its creator, its owner, or clergy who can see it. Audited (which one, never its title). */
export async function deleteFollowUp(db: Db, actor: Actor, id: unknown): Promise<void> {
  const { row, access } = await loadVisibleFollowUp(db, actor, id);
  if (!canDeleteFollowUp(actor, { ...access, createdBy: row.createdBy })) deny();
  await db.transaction(async (tx) => {
    await tx.delete(followUps).where(eq(followUps.id, row.id));
    await writeAudit(tx, actor, "follow_up.delete", "follow_up", row.id, { careItemId: row.careItemId });
  });
}
