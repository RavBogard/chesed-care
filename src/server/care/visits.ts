/**
 * "In hospital now": the open illness care items the viewer fully sees, grouped by where the person is (the item's `location`,
 * normalised for case and whitespace), for planning a round of visits. Items with no location are listed last.
 *
 * Visibility is careItemVisibleWhere (restricted items appear only for those who fully see them). The last contact and the next
 * follow-up are read through the contact and follow-up predicates too, so a note or a step the viewer may not list never
 * shows up even as a date.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { mapsUrlForPlace } from "@/lib/address";
import { personPath } from "@/lib/care-labels";
import { canSeeVisits, careItemVisibleWhere, contactEntryVisibleWhere, deny, followUpVisibleWhere, type Actor } from "@/server/access/policy";
import { careItems, contactLog, followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { auditRestrictedReads } from "./audit";
import { activeWhere, updateCareItem } from "./care-items";
import { createContactEntry } from "./contact-log";

export type VisitRow = {
  careItemId: string;
  name: string;
  href: string;
  /** The Chicago day the care item was opened. */
  since: string;
  /** The Chicago day of the last logged contact, or null. */
  lastContact: string | null;
  visitedToday: boolean;
  nextFollowUp: string | null;
};
export type VisitGroup = { key: string; label: string; mapsHref: string | null; rows: VisitRow[] };
export type Visits = { groups: VisitGroup[]; unplaced: VisitRow[] };

/** Case and whitespace normalised, so "Barnes-Jewish, rm 4" and "barnes-jewish,  RM 4" are one place. Pure. */
export function placeKey(location: string | null | undefined): string {
  return (location ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export async function listVisits(db: Db, actor: Actor, now: Date = new Date()): Promise<Visits> {
  if (!canSeeVisits(actor)) deny();
  const today = chicagoToday(now);
  const items = await db
    .select()
    .from(careItems)
    .where(and(careItemVisibleWhere(actor), eq(careItems.category, "illness"), activeWhere(today)));
  if (items.length === 0) return { groups: [], unplaced: [] };
  await auditRestrictedReads(db, actor, items);
  const ids = items.map((i) => i.id);
  const [contacts, steps] = await Promise.all([
    db
      .select({ careItemId: contactLog.careItemId, last: sql<Date>`max(${contactLog.occurredAt})` })
      .from(contactLog)
      .where(and(inArray(contactLog.careItemId, ids), contactEntryVisibleWhere(actor)))
      .groupBy(contactLog.careItemId),
    db
      .select({ careItemId: followUps.careItemId, next: sql<string>`min(${followUps.dueDate})` })
      .from(followUps)
      .where(and(inArray(followUps.careItemId, ids), isNull(followUps.doneAt), followUpVisibleWhere(actor)))
      .groupBy(followUps.careItemId),
  ]);
  const last = new Map(contacts.map((c) => [c.careItemId, c.last ? new Date(c.last) : null]));
  const next = new Map(steps.map((s) => [s.careItemId, s.next]));
  const rowOf = (i: (typeof items)[number]): VisitRow => {
    const l = last.get(i.id) ?? null;
    const lastDay = l ? chicagoToday(l) : null;
    return {
      careItemId: i.id,
      name: i.displayName,
      href: personPath(i),
      since: chicagoToday(i.createdAt),
      lastContact: lastDay,
      visitedToday: lastDay === today,
      nextFollowUp: next.get(i.id) ?? null,
    };
  };
  const byPlace = new Map<string, { label: string; rows: VisitRow[] }>();
  const unplaced: VisitRow[] = [];
  for (const i of [...items].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    const key = placeKey(i.location);
    if (!key) {
      unplaced.push(rowOf(i));
      continue;
    }
    const g = byPlace.get(key) ?? { label: (i.location ?? "").replace(/\s+/g, " ").trim(), rows: [] };
    g.rows.push(rowOf(i));
    byPlace.set(key, g);
  }
  // Those not yet visited today come first, so "Visited" moves down the list to the next person.
  const order = (a: VisitRow, b: VisitRow) => Number(a.visitedToday) - Number(b.visitedToday) || a.name.localeCompare(b.name);
  const groups = [...byPlace.entries()]
    .map(([key, g]): VisitGroup => ({ key, label: g.label, mapsHref: mapsUrlForPlace(g.label), rows: g.rows.sort(order) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { groups, unplaced: unplaced.sort(order) };
}

/** One tap: log a visit (the ordinary contact entry, so the same policy, outcome "visited" and the same effects). */
export async function markVisited(db: Db, actor: Actor, careItemId: unknown, now: Date = new Date()): Promise<void> {
  if (!canSeeVisits(actor)) deny();
  await createContactEntry(db, actor, { careItemId, kind: "visit", outcome: "visited", occurredAt: now.toISOString() });
}

/** Set where a person is, from the list (the ordinary care item update). */
export async function setVisitLocation(db: Db, actor: Actor, careItemId: unknown, location: unknown): Promise<void> {
  if (!canSeeVisits(actor)) deny();
  await updateCareItem(db, actor, careItemId, { location });
}
