/**
 * "You might reach out to": a short, quiet list on Today for clergy. It uses only facts
 * already in the care record: items the actor holds and fully sees, the contact log entries the
 * actor may list, the journeys on those items, and the Mi Sheberach list. No scoring, no
 * attendance, engagement or giving data, and no Salesforce call. Each suggestion has its reason
 * in plain words. Never more than five. A suggestion set aside is hidden for 30 days.
 */
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { personPath } from "@/lib/care-labels";
import { monthDay } from "@/lib/format";
import { canSeeOutreachSuggestions, careItemVisibleWhere, contactEntryVisibleWhere, deny, followUpVisibleWhere, type Actor } from "@/server/access/policy";
import { careItemJourneys, careItems, contactLog, followUps, miSheberachEntries, suggestionDismissals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { firstYahrzeit } from "@/server/journeys/plan";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { activeWhere } from "./care-items";
import { InvalidInput, oneOf, uuidField } from "./validate";

export const SUGGESTION_KINDS = ["no_contact", "first_yahrzeit", "standing_overdue", "mi_sheberach"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];
export const MAX_SUGGESTIONS = 5;
export const DISMISS_DAYS = 30;
export const MAX_DISMISSALS = 200;
export const DISMISS_KEEP_DAYS = 60;
export const NO_CONTACT_DAYS = 21;
export const YAHRZEIT_AHEAD_DAYS = 14;
export const STANDING_OVERDUE_DAYS = 7;
export const MI_SHEBERACH_AGE_DAYS = 60;
export const MI_SHEBERACH_CONTACT_DAYS = 30;

export type Suggestion = { kind: SuggestionKind; subjectId: string; name: string; reason: string; href: string };

const personHref = (r: { sfContactId: string | null; outsidePersonId: string | null }) => (r.outsidePersonId || r.sfContactId ? personPath(r) : "/care");

type PersonKeys = { id: string | null; sfContactId: string | null; outsidePersonId: string | null };

/** The latest contact the actor may list, per care item id, Salesforce contact and outside person, for the given people. One query. */
async function lastContacts(db: Db, actor: Actor, people: PersonKeys[]): Promise<(p: PersonKeys) => Date | null> {
  const items = people.map((p) => p.id).filter((v): v is string => !!v);
  const sf = [...new Set(people.map((p) => p.sfContactId).filter((v): v is string => !!v))];
  const out = [...new Set(people.map((p) => p.outsidePersonId).filter((v): v is string => !!v))];
  const anyOf: SQL[] = [];
  if (items.length) anyOf.push(inArray(contactLog.careItemId, items));
  if (sf.length) anyOf.push(inArray(contactLog.sfContactId, sf));
  if (out.length) anyOf.push(inArray(contactLog.outsidePersonId, out));
  if (anyOf.length === 0) return () => null;
  const rows = await db
    .select({ item: contactLog.careItemId, sf: contactLog.sfContactId, out: contactLog.outsidePersonId, last: sql<Date>`max(${contactLog.occurredAt})` })
    .from(contactLog)
    .where(and(contactEntryVisibleWhere(actor), or(...anyOf)))
    .groupBy(contactLog.careItemId, contactLog.sfContactId, contactLog.outsidePersonId);
  return (p) => {
    let best: Date | null = null;
    for (const r of rows) {
      const hit = (p.id && r.item === p.id) || (p.sfContactId && r.sf === p.sfContactId) || (p.outsidePersonId && r.out === p.outsidePersonId);
      if (hit && (!best || new Date(r.last) > best)) best = new Date(r.last);
    }
    return best;
  };
}

/** `everything`: every current suggestion, dismissed or not and past the cap of five (used to check a dismissal names a real one). */
export async function getOutreachSuggestions(db: Db, actor: Actor, now: Date = new Date(), opts: { everything?: boolean } = {}): Promise<Suggestion[]> {
  if (!canSeeOutreachSuggestions(actor)) deny();
  const today = chicagoToday(now);
  const dismissed = await db
    .select({ kind: suggestionDismissals.kind, subjectId: suggestionDismissals.subjectId })
    .from(suggestionDismissals)
    .where(and(eq(suggestionDismissals.userId, actor.id), gte(suggestionDismissals.dismissedAt, new Date(now.getTime() - DISMISS_DAYS * 86_400_000))));
  const hidden = new Set(dismissed.map((d) => `${d.kind}|${d.subjectId}`));
  const keep = (s: Suggestion) => !hidden.has(`${s.kind}|${s.subjectId}`);

  const standingCutoff = addDays(today, -STANDING_OVERDUE_DAYS);
  const miAgeCutoff = addDays(today, -MI_SHEBERACH_AGE_DAYS);
  const [mine, closedBereavement, standing, miRows] = await Promise.all([
    db
      .select({ id: careItems.id, name: careItems.displayName, sfContactId: careItems.sfContactId, outsidePersonId: careItems.outsidePersonId, createdAt: careItems.createdAt })
      .from(careItems)
      .where(and(careItemVisibleWhere(actor), eq(careItems.ownerUserId, actor.id), activeWhere(today))),
    db
      .select({ id: careItems.id, name: careItems.displayName, sfContactId: careItems.sfContactId, outsidePersonId: careItems.outsidePersonId, anchor: careItemJourneys.anchorDate })
      .from(careItems)
      .innerJoin(careItemJourneys, and(eq(careItemJourneys.careItemId, careItems.id), eq(careItemJourneys.templateKey, "bereavement_year")))
      .where(and(careItemVisibleWhere(actor), eq(careItems.ownerUserId, actor.id), eq(careItems.status, "closed"), eq(careItems.category, "bereavement"))),
    db
      .select({ id: followUps.id, name: followUps.displayName, due: followUps.dueDate, sfContactId: followUps.sfContactId, outsidePersonId: followUps.outsidePersonId })
      .from(followUps)
      .innerJoin(careItemJourneys, and(eq(careItemJourneys.id, followUps.journeyId), eq(careItemJourneys.templateKey, "standing"), isNull(careItemJourneys.endedAt)))
      .where(and(followUpVisibleWhere(actor), eq(followUps.ownerUserId, actor.id), isNull(followUps.doneAt), lt(followUps.dueDate, standingCutoff)))
      .orderBy(followUps.dueDate),
    db
      .select({ id: miSheberachEntries.id, name: miSheberachEntries.name, sfContactId: miSheberachEntries.sfContactId, outsidePersonId: miSheberachEntries.outsidePersonId, careItemId: miSheberachEntries.careItemId, added: miSheberachEntries.dateAdded })
      .from(miSheberachEntries)
      .where(and(isNull(miSheberachEntries.endedAt), lte(miSheberachEntries.dateAdded, miAgeCutoff)))
      .orderBy(miSheberachEntries.dateAdded),
  ]);

  // Open follow-ups on the closed bereavement items (to know whether anything is planned) and the latest contacts: one query each.
  const bereavementIds = closedBereavement.map((r) => r.id);
  const [planned, contactOf] = await Promise.all([
    bereavementIds.length
      ? db.select({ id: followUps.careItemId }).from(followUps).where(and(followUpVisibleWhere(actor), isNull(followUps.doneAt), inArray(followUps.careItemId, bereavementIds)))
      : Promise.resolve([]),
    lastContacts(db, actor, [...mine.map((r) => ({ id: r.id, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId })), ...miRows.map((r) => ({ id: r.careItemId, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId }))]),
  ]);
  const plannedIds = new Set(planned.map((p) => p.id));

  const yahrzeit: Suggestion[] = closedBereavement
    .map((r) => ({ r, date: firstYahrzeit(r.anchor) }))
    .filter(({ r, date }) => date >= today && date <= addDays(today, YAHRZEIT_AHEAD_DAYS) && !plannedIds.has(r.id))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ r, date }) => ({ kind: "first_yahrzeit", subjectId: r.id, name: r.name, reason: `The first yahrzeit is on ${monthDay(date)} and nothing is planned.`, href: personHref(r) }));

  const standingList: Suggestion[] = standing.map((r) => ({ kind: "standing_overdue", subjectId: r.id, name: r.name ?? "Name not recorded", reason: `A standing check-in was due ${monthDay(r.due)}.`, href: personHref(r) }));

  const noContact: Suggestion[] = mine
    .map((r) => ({ r, last: contactOf({ id: r.id, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId }) }))
    .map(({ r, last }) => ({ r, last, since: last ? chicagoToday(last) : chicagoToday(r.createdAt) }))
    .filter(({ since }) => since < addDays(today, -NO_CONTACT_DAYS))
    .sort((a, b) => a.since.localeCompare(b.since))
    .map(({ r, last, since }) => ({
      kind: "no_contact",
      subjectId: r.id,
      name: r.name,
      reason: last ? `No contact has been logged since ${monthDay(since)}.` : `No contact has been logged yet, and the item is from ${monthDay(since)}.`,
      href: personHref(r),
    }));

  const contactCutoff = addDays(today, -MI_SHEBERACH_CONTACT_DAYS);
  const mi: Suggestion[] = miRows
    .filter((r) => {
      const last = contactOf({ id: r.careItemId, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId });
      return !last || chicagoToday(last) < contactCutoff;
    })
    .map((r) => ({ kind: "mi_sheberach", subjectId: r.id, name: r.name, reason: `On the Mi Sheberach list since ${monthDay(r.added)}, with no contact logged in the last ${MI_SHEBERACH_CONTACT_DAYS} days.`, href: r.sfContactId || r.outsidePersonId ? personHref(r) : "/mi-sheberach" }));

  const all = [...yahrzeit, ...standingList, ...noContact, ...mi];
  return opts.everything ? all : all.filter(keep).slice(0, MAX_SUGGESTIONS);
}

/** Set a suggestion aside for 30 days. It stores which suggestion and who set it aside, nothing about the person. */
export async function dismissSuggestion(db: Db, actor: Actor, input: { kind: unknown; subjectId: unknown }, now: Date = new Date()): Promise<void> {
  if (!canSeeOutreachSuggestions(actor)) deny();
  const kind = oneOf(input.kind, "kind", SUGGESTION_KINDS);
  const subjectId = uuidField(input.subjectId, "subjectId");
  if (!subjectId) throw new InvalidInput("subjectId");
  // Only a suggestion the person has right now can be set aside: nothing is stored for an arbitrary id.
  const current = await getOutreachSuggestions(db, actor, now, { everything: true });
  if (!current.some((s) => s.kind === kind && s.subjectId === subjectId)) throw new InvalidInput("subjectId");
  await db
    .insert(suggestionDismissals)
    .values({ userId: actor.id, kind, subjectId, dismissedAt: now })
    .onConflictDoUpdate({ target: [suggestionDismissals.userId, suggestionDismissals.kind, suggestionDismissals.subjectId], set: { dismissedAt: now } });
  // At most MAX_DISMISSALS kept per person: the oldest go first.
  const old = await db
    .select({ kind: suggestionDismissals.kind, subjectId: suggestionDismissals.subjectId })
    .from(suggestionDismissals)
    .where(eq(suggestionDismissals.userId, actor.id))
    .orderBy(desc(suggestionDismissals.dismissedAt))
    .offset(MAX_DISMISSALS);
  for (const o of old) await db.delete(suggestionDismissals).where(and(eq(suggestionDismissals.userId, actor.id), eq(suggestionDismissals.kind, o.kind), eq(suggestionDismissals.subjectId, o.subjectId)));
}
