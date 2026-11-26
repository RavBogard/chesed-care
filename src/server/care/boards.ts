/**
 * The care data behind the Today and Care list screens, for the acting user.
 * Everything is read through the policy-checked list functions.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { isCareTeam, type Actor } from "@/server/access/policy";
import { followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CARE_CATEGORIES, listCareItems, type CareItem } from "./care-items";
import { auditRestrictedReads } from "./audit";
import { auditFollowUpReads, listFollowUps, type FollowUp } from "./follow-ups";
import { chicagoToday } from "@/server/lifecycle/window";
import { listTeam } from "./users";
import { dateField, oneOf } from "./validate";

export { CARE_CATEGORIES };
export type CareCategory = (typeof CARE_CATEGORIES)[number];

export type TodayCare = {
  /** Open follow-ups due today or earlier that are the actor's or no one's, oldest first. */
  due: FollowUp[];
  /** The actor's active care items (new, open, or paused and due back) with no open follow-up: nothing is planned for them. */
  attention: CareItem[];
  /** Follow-ups the actor marked done today (Chicago): with `due`, the day’s count and its finish line. */
  doneToday: number;
};

export async function getTodayCare(db: Db, actor: Actor, today: unknown): Promise<TodayCare> {
  const day = dateField(today, "today");
  // A Mitzvah Corps lead's steps are listed through listLeadSteps, in their narrow shape: never as follow-up rows that carry a care item id.
  if (!isCareTeam(actor)) return { due: [], attention: [], doneToday: 0 };
  // Reads are audited below, after the rows are narrowed to what the screen shows.
  const [open, items] = await Promise.all([listFollowUps(db, actor, { open: true, audit: false }), listCareItems(db, actor, { status: "active", today: day, audit: false })]);
  const planned = new Set(open.map((f) => f.careItemId).filter(Boolean));
  const due = open.filter((f) => f.dueDate <= day && (f.ownerUserId === actor.id || f.ownerUserId === null));
  const attention = items.filter((i) => i.ownerUserId === actor.id && !planned.has(i.id));
  await Promise.all([auditFollowUpReads(db, actor, due), auditRestrictedReads(db, actor, attention)]);
  const [{ n: doneToday }] = await db
    .select({ n: count() })
    .from(followUps)
    .where(and(eq(followUps.ownerUserId, actor.id), sql`(${followUps.doneAt} at time zone 'America/Chicago')::date = ${day}::date`));
  return { due, attention, doneToday };
}

export type CareBoardRow = CareItem & { ownerName: string | null; nextFollowUp: string | null };
/** status "open" is the active list: new, open, and paused items that are due back. "paused" is those still set aside. */
export type CareBoardFilter = { scope: "mine" | "all"; category: CareCategory | null; status: "open" | "paused" | "closed" };

/** Parse the Care list's query string; anything unexpected falls back to the default. */
export function parseCareBoardFilter(q: { scope?: unknown; category?: unknown; status?: unknown }): CareBoardFilter {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
    try {
      return oneOf(v, "filter", allowed);
    } catch {
      return fallback;
    }
  };
  return {
    scope: pick(q.scope, ["mine", "all"] as const, "all"),
    category: (CARE_CATEGORIES as readonly unknown[]).includes(q.category) ? (q.category as CareCategory) : null,
    status: pick(q.status, ["open", "paused", "closed"] as const, "open"),
  };
}

/**
 * Care items for the list, with their owner's name and next open follow-up date, grouped order: category, then next date.
 * Only items the actor fully sees; restricted items shown as a stub come from listCareItemStubs.
 */
export async function listCareBoard(db: Db, actor: Actor, filter: CareBoardFilter, today: string = chicagoToday(new Date())): Promise<CareBoardRow[]> {
  const status = filter.status === "open" ? "active" : filter.status;
  const [items, open, team] = await Promise.all([listCareItems(db, actor, { status, today, audit: false }), listFollowUps(db, actor, { open: true, audit: false }), listTeam(db, actor)]);
  const names = new Map(team.map((m) => [m.id, m.name ?? m.email]));
  const next = new Map<string, string>();
  for (const f of open) if (f.careItemId && !next.has(f.careItemId)) next.set(f.careItemId, f.dueDate);
  const shown = items.filter((i) => (filter.scope === "mine" ? i.ownerUserId === actor.id : true)).filter((i) => (filter.category ? i.category === filter.category : true));
  await auditRestrictedReads(db, actor, shown);
  return shown
    .map((i) => ({ ...i, ownerName: names.get(i.ownerUserId) ?? null, nextFollowUp: next.get(i.id) ?? null }))
    .sort((a, b) => CARE_CATEGORIES.indexOf(a.category) - CARE_CATEGORIES.indexOf(b.category) || (a.nextFollowUp ?? "9999").localeCompare(b.nextFollowUp ?? "9999") || a.displayName.localeCompare(b.displayName));
}
