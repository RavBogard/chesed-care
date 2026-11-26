/**
 * The standing visiting list: members (often in care homes) whom vetted volunteers visit. Clergy (owner, clergy) decide who is
 * on it; the lead also sees it, assigns a regular visitor and logs visits. It carries NO health information: a place, a contact
 * line (for example a family member's phone) and a note for the visitor. Everyone else is refused, and the screens answer them
 * as if the page did not exist. Audit rows hold ids only, never a name, a place or a note.
 */
import { and, count, eq, inArray, isNull, max, sql, type SQL } from "drizzle-orm";
import { canAssignVisitor, canLogVolunteerVisit, canManageVisitingList, canSeeVisitingList, deny, isClergyLevel, outsidePersonVisibleWhere, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { resolvePersonRef } from "@/server/care/person-ref";
import type { PersonDeps } from "@/server/care/person-page";
import { dateField, InvalidInput, NotFound, optionalText, uuidField, uuidOrNotFound } from "@/server/care/validate";
import { corpsMembers, outsidePeople, visitingList, visitingVisits } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { askable, effectiveStatus } from "./roster";

/** A visit may be logged for today or up to this many days back. */
export const VISIT_BACK_DAYS = 60;

const NO_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/;
const line = (v: unknown, field: string, max: number): string | null => {
  const t = optionalText(v, field, max);
  if (t !== null && NO_CONTROL.test(t)) throw new InvalidInput(field);
  return t;
};

export type VisitingEntry = {
  id: string;
  sfContactId: string | null;
  outsidePersonId: string | null;
  name: string;
  place: string | null;
  contactLine: string | null;
  visitorNote: string | null;
  visitorMemberId: string | null;
  visitorName: string | null;
  lastVisit: string | null;
  visitCount: number;
};

export type VisitorChoice = { id: string; name: string; canVisit: boolean };

export { personPath as visitingPersonHref } from "@/lib/care-labels";

/**
 * Entries the viewer may know exist. An outside person is hidden from a clergy-level viewer (the owner included: no role
 * overrides a restriction) when every care item about them is restricted away from that viewer, the house rule everywhere
 * else. The lead has no care access and sees every entry, but no person links.
 */
function entryVisibleWhere(actor: Actor): SQL | undefined {
  if (!isClergyLevel(actor)) return undefined;
  return sql`(${visitingList.outsidePersonId} is null or exists (select 1 from ${outsidePeople} where ${outsidePeople.id} = ${visitingList.outsidePersonId} and ${outsidePersonVisibleWhere(actor)}))`;
}

export type VisitingInput = { sfContactId?: unknown; outsidePersonId?: unknown; displayName?: unknown; place?: unknown; contactLine?: unknown; visitorNote?: unknown };

/** Clergy put a person on the list. One active entry per person: a second add is refused. */
export async function addToVisitingList(db: Db, actor: Actor, input: VisitingInput, deps: { sf: PersonDeps["sf"]; now?: Date }): Promise<{ id: string }> {
  if (!canManageVisitingList(actor)) deny();
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  const hasOutside = given(input.outsidePersonId);
  if (given(input.sfContactId) === hasOutside) throw new InvalidInput("person");
  let sfContactId: string | null = null;
  let outsidePersonId: string | null = null;
  let displayName: string;
  if (hasOutside) {
    const id = uuidField(input.outsidePersonId, "outsidePersonId");
    // A person the viewer cannot see is answered exactly like one who does not exist.
    const [p] = await db.select({ id: outsidePeople.id, name: outsidePeople.name }).from(outsidePeople).where(and(eq(outsidePeople.id, id), outsidePersonVisibleWhere(actor))).limit(1);
    if (!p) throw new NotFound();
    outsidePersonId = p.id;
    displayName = p.name;
  } else {
    // The name is read from Salesforce on the server (cached for the day), never taken from the form; an unknown contact is refused.
    const person = await resolvePersonRef({ db, sf: deps.sf, now: deps.now ?? new Date() }, actor, input.sfContactId);
    sfContactId = person.sfContactId;
    displayName = person.displayName;
  }
  const place = line(input.place, "place", 300);
  const contactLine = line(input.contactLine, "contactLine", 200);
  const visitorNote = line(input.visitorNote, "visitorNote", 300);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(visitingList)
      .values({ sfContactId, outsidePersonId, displayName, place, contactLine, visitorNote, addedBy: actor.id })
      .onConflictDoNothing()
      .returning({ id: visitingList.id });
    if (!row) throw new InvalidInput("person");
    await writeAudit(tx, actor, "visiting.add", "visiting_entry", row.id, { visitingId: row.id });
    return row;
  });
}

async function loadActive(db: Db, actor: Actor, id: unknown) {
  const [row] = await db.select().from(visitingList).where(and(eq(visitingList.id, uuidOrNotFound(id)), isNull(visitingList.endedAt), entryVisibleWhere(actor))).limit(1);
  if (!row) throw new NotFound();
  return row;
}

/** Clergy change the place, the contact line or the note for the visitor. */
export async function updateVisitingEntry(db: Db, actor: Actor, id: unknown, input: Pick<VisitingInput, "place" | "contactLine" | "visitorNote">): Promise<void> {
  if (!canManageVisitingList(actor)) deny();
  const entry = await loadActive(db, actor, id);
  const set = { place: line(input.place, "place", 300), contactLine: line(input.contactLine, "contactLine", 200), visitorNote: line(input.visitorNote, "visitorNote", 300) };
  await db.transaction(async (tx) => {
    await tx.update(visitingList).set(set).where(eq(visitingList.id, entry.id));
    await writeAudit(tx, actor, "visiting.update", "visiting_entry", entry.id, { visitingId: entry.id });
  });
}

/** Clergy take a person off the list. The entry and its visits are kept (Daniel, 2026-11-25: "Keep everything"), no longer shown. */
export async function endVisitingEntry(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<void> {
  if (!canManageVisitingList(actor)) deny();
  const entry = await loadActive(db, actor, id);
  await db.transaction(async (tx) => {
    await tx.update(visitingList).set({ endedAt: now, visitorMemberId: null, visitorSetBy: null }).where(eq(visitingList.id, entry.id));
    await writeAudit(tx, actor, "visiting.end", "visiting_entry", entry.id, { visitingId: entry.id });
  });
}

/** The active entries, for the screen: who, where, the regular visitor, the last visit and how many visits. */
export async function listVisiting(db: Db, actor: Actor, now: Date = new Date()): Promise<VisitingEntry[]> {
  if (!canSeeVisitingList(actor)) deny();
  const rows = await db
    .select({ e: visitingList, visitorFirst: corpsMembers.firstName, visitorLast: corpsMembers.lastName, visitorStatus: corpsMembers.status, visitorPausedUntil: corpsMembers.pausedUntil })
    .from(visitingList)
    .leftJoin(corpsMembers, eq(corpsMembers.id, visitingList.visitorMemberId))
    .where(and(isNull(visitingList.endedAt), entryVisibleWhere(actor)))
    .orderBy(visitingList.displayName);
  const stats = rows.length
    ? await db.select({ id: visitingVisits.listId, last: max(visitingVisits.visitedOn), n: count() }).from(visitingVisits).where(inArray(visitingVisits.listId, rows.map((r) => r.e.id))).groupBy(visitingVisits.listId)
    : [];
  const byId = new Map(stats.map((s) => [s.id, s]));
  const today = chicagoToday(now);
  return rows.map(({ e, visitorFirst, visitorLast, visitorStatus, visitorPausedUntil }) => {
    // The visitor is shown only while they are active on the roster.
    const visitorActive = e.visitorMemberId !== null && visitorStatus !== null && effectiveStatus({ status: visitorStatus, pausedUntil: visitorPausedUntil }, today) === "active";
    return {
    id: e.id,
    sfContactId: e.sfContactId,
    outsidePersonId: e.outsidePersonId,
    name: e.displayName,
    place: e.place,
    contactLine: e.contactLine,
    visitorNote: e.visitorNote,
    visitorMemberId: visitorActive ? e.visitorMemberId : null,
    visitorName: visitorActive ? [visitorFirst, visitorLast].filter(Boolean).join(" ") : null,
    lastVisit: byId.get(e.id)?.last ?? null,
    visitCount: Number(byId.get(e.id)?.n ?? 0),
    };
  });
}

/** For a person's page (clergy only): their active entry's id, or null. Everyone else gets null and no hint that the list exists. */
export async function visitingEntryFor(db: Db, actor: Actor, ref: { sfContactId?: string | null; outsidePersonId?: string | null }): Promise<string | null> {
  if (!canManageVisitingList(actor)) return null;
  const who = ref.outsidePersonId ? eq(visitingList.outsidePersonId, ref.outsidePersonId) : ref.sfContactId ? eq(visitingList.sfContactId, ref.sfContactId) : null;
  if (!who) return null;
  const [row] = await db.select({ id: visitingList.id }).from(visitingList).where(and(who, isNull(visitingList.endedAt), entryVisibleWhere(actor))).limit(1);
  return row?.id ?? null;
}

/** Active roster members for the "regular visitor" choice: those who said they can do visits first. */
export async function listVisitorChoices(db: Db, actor: Actor, now: Date = new Date()): Promise<VisitorChoice[]> {
  if (!canAssignVisitor(actor)) deny();
  const today = chicagoToday(now);
  // Only volunteers: a member from the old "IL members" tab who has not volunteered is never offered.
  const rows = (await db.select().from(corpsMembers)).filter((m) => askable(m, today));
  return rows
    .map((m) => ({ id: m.id, name: [m.firstName, m.lastName].filter(Boolean).join(" "), canVisit: m.canDo.includes("visits") }))
    .sort((a, b) => Number(b.canVisit) - Number(a.canVisit) || a.name.localeCompare(b.name));
}

/** Set the regular visitor (an active roster member), or clear it with null. */
export async function setVisitor(db: Db, actor: Actor, id: unknown, memberId: unknown, now: Date = new Date()): Promise<void> {
  if (!canAssignVisitor(actor)) deny();
  const entry = await loadActive(db, actor, id);
  let member: string | null = null;
  if (memberId !== null && memberId !== undefined && memberId !== "") {
    member = uuidField(memberId, "memberId");
    const [m] = await db.select().from(corpsMembers).where(eq(corpsMembers.id, member)).limit(1);
    if (!m || m.contactPurgedAt !== null || !askable(m, chicagoToday(now))) throw new InvalidInput("memberId");
  }
  await db.transaction(async (tx) => {
    await tx.update(visitingList).set({ visitorMemberId: member, visitorSetBy: member ? actor.id : null }).where(eq(visitingList.id, entry.id));
    await writeAudit(tx, actor, "visiting.visitor", "visiting_entry", entry.id, { visitingId: entry.id, ...(member ? { memberId: member } : {}) });
  });
}

/** Log a visit: a day that is not in the future and not more than 60 days back. */
export async function logVisit(db: Db, actor: Actor, id: unknown, visitedOn: unknown, now: Date = new Date()): Promise<void> {
  if (!canLogVolunteerVisit(actor)) deny();
  const entry = await loadActive(db, actor, id);
  const today = chicagoToday(now);
  const day = dateField(visitedOn, "visitedOn");
  if (day > today || day < addDays(today, -VISIT_BACK_DAYS)) throw new InvalidInput("visitedOn");
  await db.transaction(async (tx) => {
    const [made] = await tx.insert(visitingVisits).values({ listId: entry.id, visitedOn: day, loggedBy: actor.id, memberId: entry.visitorMemberId }).onConflictDoNothing().returning({ id: visitingVisits.id });
    // The same day twice is a quiet no-op.
    if (made) await writeAudit(tx, actor, "visiting.visit", "visiting_entry", entry.id, { visitingId: entry.id });
  });
}
