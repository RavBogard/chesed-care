/**
 * The clergy meeting agenda: a shared running list for the weekly conversation (owner and clergy only).
 *
 * The restricted rule is in SQL, in one place: agendaEntryVisibleWhere (src/server/access/policy.ts). Every read and every
 * change below goes through it, so an entry about a restricted item is, for anyone shut out of that item, not a row, not
 * a count, not a placeholder and not a line in the print view. Free-text entries (no person) are visible to all clergy.
 *
 * `why` and `outcome` are free text: never logged, never in an audit row (ids only).
 */
import { and, asc, eq, inArray, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import { addDays, chicagoToday, DAY_MS } from "@/server/lifecycle/window";
import { agendaEntryVisibleWhere, canAddAgendaForItem, canUseAgenda, deny, type Actor } from "@/server/access/policy";
import { agendaEntries, careItems, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { auditRestrictedReadsByItem, writeAudit, writeSystemAudit } from "./audit";
import { loadVisibleCareItemAccess } from "./care-items";
import { createFollowUp } from "./follow-ups";
import { personSubject } from "./outside-people";
import { dateField, InvalidInput, isUuid, NotFound, optionalText, text, uuidField } from "./validate";

export const WHY_MAX = 200;
export const OUTCOME_MAX = 200;
export const FREE_TEXT_MAX = 120;
/** A discussed entry stays on the screen this long, and in the database this long. */
export const DISCUSSED_SHOW_DAYS = 14;
export const DISCUSSED_KEEP_DAYS = 90;

type Row = typeof agendaEntries.$inferSelect;
export type AgendaEntry = Row & { addedByName: string | null; discussedByName: string | null; restricted: boolean };

/** The Monday (a Chicago date key) of the week that holds `day`. Pure. */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export type AddInput = { careItemId?: unknown; sfContactId?: unknown; outsidePersonId?: unknown; displayName?: unknown; why?: unknown };

/**
 * Add an entry for a care item the actor fully sees, a person they can see, or free text. Returns the entry and whether it is
 * about a restricted item (so the screen can warn that only the named clergy will see it).
 */
export async function addAgendaEntry(db: Db, actor: Actor, input: AddInput, now: Date = new Date()): Promise<{ id: string; restricted: boolean }> {
  if (!canUseAgenda(actor)) deny();
  const why = optionalText(input.why, "why", WHY_MAX);
  const blank = (v: unknown) => v === undefined || v === null || v === "";
  let values: Pick<typeof agendaEntries.$inferInsert, "careItemId" | "sfContactId" | "outsidePersonId" | "displayName">;
  let restricted = false;
  if (!blank(input.careItemId)) {
    const { item, access } = await loadVisibleCareItemAccess(db, actor, input.careItemId);
    if (!canAddAgendaForItem(actor, access)) deny();
    restricted = item.restricted;
    values = { careItemId: item.id, sfContactId: item.sfContactId, outsidePersonId: item.outsidePersonId, displayName: item.displayName };
  } else if (!blank(input.sfContactId) || !blank(input.outsidePersonId)) {
    const person = await personSubject(db, actor, input, true);
    values = { careItemId: null, sfContactId: person.sfContactId, outsidePersonId: person.outsidePersonId, displayName: person.displayName };
  } else {
    values = { careItemId: null, sfContactId: null, outsidePersonId: null, displayName: text(input.displayName, "displayName", FREE_TEXT_MAX) };
  }
  const [row] = await db
    .insert(agendaEntries)
    .values({ ...values, why, weekOf: mondayOf(chicagoToday(now)), addedBy: actor.id })
    .returning({ id: agendaEntries.id });
  await writeAudit(db, actor, "agenda.add", "agenda_entry", row.id, { careItemId: values.careItemId ?? null, restricted });
  return { id: row.id, restricted };
}

export type AgendaView = { toDiscuss: AgendaEntry[]; nextWeek: AgendaEntry[]; discussed: AgendaEntry[]; thisWeek: string };

/** The agenda as the actor may see it. Everything is filtered in SQL; the groups are made from the rows that came back. */
export async function listAgenda(db: Db, actor: Actor, now: Date = new Date()): Promise<AgendaView> {
  if (!canUseAgenda(actor)) deny();
  const thisWeek = mondayOf(chicagoToday(now));
  const shownSince = new Date(now.getTime() - DISCUSSED_SHOW_DAYS * DAY_MS);
  const rows = await db
    .select({ row: agendaEntries })
    .from(agendaEntries)
    .where(and(agendaEntryVisibleWhere(actor), or(isNull(agendaEntries.discussedAt), gte(agendaEntries.discussedAt, shownSince))))
    .orderBy(asc(agendaEntries.weekOf), asc(agendaEntries.createdAt));
  await auditRestrictedReadsByItem(db, actor, rows.map((r) => r.row.careItemId));
  const linked = [...new Set(rows.map((r) => r.row.careItemId).filter((id): id is string => id !== null))];
  const restrictedIds = new Set(linked.length ? (await db.select({ id: careItems.id }).from(careItems).where(and(inArray(careItems.id, linked), eq(careItems.restricted, true)))).map((c) => c.id) : []);
  const names = new Map((await db.select({ id: users.id, name: users.name, email: users.email }).from(users)).map((u) => [u.id, u.name ?? u.email]));
  const entries: AgendaEntry[] = rows.map((r) => ({ ...r.row, addedByName: names.get(r.row.addedBy) ?? null, discussedByName: r.row.discussedBy ? (names.get(r.row.discussedBy) ?? null) : null, restricted: r.row.careItemId !== null && restrictedIds.has(r.row.careItemId) }));
  return {
    thisWeek,
    toDiscuss: entries.filter((e) => !e.discussedAt && e.weekOf <= thisWeek),
    nextWeek: entries.filter((e) => !e.discussedAt && e.weekOf > thisWeek),
    discussed: entries.filter((e) => e.discussedAt).sort((a, b) => b.discussedAt!.getTime() - a.discussedAt!.getTime()),
  };
}

/** An entry the actor may see, or NotFound (missing and hidden look the same). */
async function loadVisibleEntry(db: Db, actor: Actor, id: unknown): Promise<Row> {
  if (!canUseAgenda(actor)) deny();
  if (!isUuid(id)) throw new NotFound();
  const [row] = await db.select().from(agendaEntries).where(and(eq(agendaEntries.id, id), agendaEntryVisibleWhere(actor))).limit(1);
  if (!row) throw new NotFound();
  return row;
}

/**
 * Tick an entry as discussed, with an optional one-line outcome and an optional follow-up for a chosen clergy member
 * (made through createFollowUp, so the ordinary rules apply: on a restricted item only someone who can see it may hold it).
 */
export async function discussAgendaEntry(
  db: Db,
  actor: Actor,
  id: unknown,
  input: { outcome?: unknown; followUp?: { ownerUserId: unknown; title?: unknown; dueDate?: unknown } | null } = {},
  now: Date = new Date(),
): Promise<{ followUpId: string | null }> {
  const row = await loadVisibleEntry(db, actor, id);
  const outcome = optionalText(input.outcome, "outcome", OUTCOME_MAX);
  let followUpId: string | null = null;
  if (input.followUp) {
    const subject = row.careItemId ? { careItemId: row.careItemId } : row.outsidePersonId ? { outsidePersonId: row.outsidePersonId } : row.sfContactId ? { sfContactId: row.sfContactId, displayName: row.displayName } : null;
    if (!subject) throw new InvalidInput("followUp");
    const ownerUserId = uuidField(input.followUp.ownerUserId, "ownerUserId");
    const title = optionalText(input.followUp.title, "title", 200) ?? "Follow up after the clergy meeting";
    const dueDate = input.followUp.dueDate ? dateField(input.followUp.dueDate, "dueDate") : addDays(chicagoToday(now), 7);
    followUpId = (await createFollowUp(db, actor, { ...subject, title, dueDate, ownerUserId })).id;
  }
  if (!row.discussedAt) await db.update(agendaEntries).set({ discussedAt: now, discussedBy: actor.id, outcome }).where(eq(agendaEntries.id, row.id));
  await writeAudit(db, actor, "agenda.discuss", "agenda_entry", row.id, { careItemId: row.careItemId });
  return { followUpId };
}

/** Carry an undiscussed entry to the next meeting week. */
export async function carryAgendaEntry(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<void> {
  const row = await loadVisibleEntry(db, actor, id);
  if (row.discussedAt) throw new InvalidInput("id");
  const base = row.weekOf > mondayOf(chicagoToday(now)) ? row.weekOf : mondayOf(chicagoToday(now));
  await db.update(agendaEntries).set({ weekOf: addDays(base, 7) }).where(eq(agendaEntries.id, row.id));
  await writeAudit(db, actor, "agenda.carry", "agenda_entry", row.id, { careItemId: row.careItemId });
}

/** Take an entry off the agenda: whoever added it, or the owner. */
export async function removeAgendaEntry(db: Db, actor: Actor, id: unknown): Promise<void> {
  const row = await loadVisibleEntry(db, actor, id);
  if (row.addedBy !== actor.id && actor.role !== "owner") deny();
  await db.delete(agendaEntries).where(eq(agendaEntries.id, row.id));
  await writeAudit(db, actor, "agenda.remove", "agenda_entry", row.id, { careItemId: row.careItemId });
}

/** The daily job: entries discussed more than 90 days ago are deleted. No actor, counts only. */
export async function purgeAgenda(db: Db, now: Date): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - DISCUSSED_KEEP_DAYS * DAY_MS);
  // Discussed more than 90 days ago, or never discussed and for a week more than 90 days past.
  const staleWeek = addDays(chicagoToday(now), -DISCUSSED_KEEP_DAYS);
  const gone = await db
    .delete(agendaEntries)
    .where(or(and(isNotNull(agendaEntries.discussedAt), lt(agendaEntries.discussedAt, cutoff)), and(isNull(agendaEntries.discussedAt), lt(agendaEntries.weekOf, staleWeek))))
    .returning({ id: agendaEntries.id });
  if (gone.length > 0) await writeSystemAudit(db, "agenda.purge", "agenda_entry", gone[0].id, { count: gone.length });
  return { deleted: gone.length };
}
