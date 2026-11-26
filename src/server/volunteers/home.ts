/**
 * The coordinator's home: what needs someone, their own Mitzvah Corps steps, meal pages with open nights, what
 * changed in the last two days, and the week's filled tasks. One read for owner, clergy and the lead, all through
 * the same visibility rules as the lists it summarises: volunteerTaskVisibleWhere, mealPageVisibleWhere and
 * followUpVisibleWhere, so a task or step on a RESTRICTED care item reaches no one without full access, a lead
 * included. It selects no care-item column but the logistics line (which is null on a restricted item), and
 * returns nothing of a care record: no category, summary, notes or care-item id.
 */
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { canManageMealPages, canManageRoster, deny, followUpVisibleWhere, mealPageVisibleWhere, volunteerTaskVisibleWhere, type Actor } from "@/server/access/policy";
import { listPracticalRequests, type PracticalRequest } from "@/server/care/practical";
import { careItems, followUps, mealPages, mealSignups, mealSlots, volunteerClaims, volunteerGroups, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { daysBetween } from "@/lib/format";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { activeCounts, placesLeft } from "./core";
import type { Kind } from "./input";
import { listOpenReferrals, type OpenReferral } from "./referrals";

export const CHANGE_HOURS = 48;
const MAX_NEEDS = 30;
const MAX_CHANGES = 30;

export type NeedsItem = { id: string; kind: Kind; label: string; date: string; timeWindow: string | null; daysLeft: number; placesLeft: number; href: string; askHref: string };
export type HomeStep = { id: string; person: string; title: string; dueDate: string; corpsNote: string | null; mealsHref: string | null };
export type HomeMeal = { id: string; title: string; openNights: { date: string; meal: string }[]; href: string };
export type ChangeKind = "signed_up" | "gave_back" | "removed" | "done" | "flagged" | "meal_signed_up" | "meal_cancelled";
export type Change = { at: Date; kind: ChangeKind; firstName: string | null; label: string; note: string | null; href: string };
export type WeekDay = { date: string; items: { id: string; kind: Kind; label: string; timeWindow: string | null; href: string }[] };

export type CoordinatorHome = { today: string; asked: PracticalRequest[]; /** Open referrals from the rabbis, oldest first: nothing of a care record. */ referrals: OpenReferral[]; needsSomeone: NeedsItem[]; mySteps: HomeStep[]; meals: HomeMeal[] | null; changes: Change[]; thisWeek: WeekDay[] };


export async function getCoordinatorHome(db: Db, actor: Actor, now: Date = new Date()): Promise<CoordinatorHome> {
  if (!canManageRoster(actor)) deny();
  const today = chicagoToday(now);
  const [needsAndWeek, mySteps, meals, changes, asked, referrals] = await Promise.all([tasksAhead(db, actor, today), listMySteps(db, actor), mealsOpen(db, actor, today), changesSince(db, actor, now), listPracticalRequests(db, actor), listOpenReferrals(db, actor)]);
  return { today, asked, referrals, ...needsAndWeek, mySteps, meals, changes };
}

async function tasksAhead(db: Db, actor: Actor, today: string): Promise<{ needsSomeone: NeedsItem[]; thisWeek: WeekDay[] }> {
  const rows = await db
    .select({ task: volunteerTasks, sheet: volunteerGroups.title, sheetCancelled: volunteerGroups.cancelledAt })
    .from(volunteerTasks)
    .leftJoin(volunteerGroups, eq(volunteerGroups.id, volunteerTasks.groupId))
    .where(and(volunteerTaskVisibleWhere(actor), eq(volunteerTasks.status, "open"), gte(volunteerTasks.taskDate, today)))
    .orderBy(asc(volunteerTasks.taskDate), asc(volunteerTasks.createdAt));
  const counts = await activeCounts(db, rows.map((r) => r.task.id));
  const live = rows.filter((r) => !r.sheetCancelled);
  const href = (r: (typeof rows)[number]) => (r.task.groupId ? `/volunteers/sheets/${r.task.groupId}` : `/volunteers/${r.task.id}`);
  const label = (r: (typeof rows)[number]) => (r.task.groupId ? `Shiva for ${r.sheet ?? r.task.forLabel}` : r.task.forLabel);
  const needsSomeone = live
    .map((r) => ({ r, left: placesLeft(r.task, counts.get(r.task.id) ?? 0) }))
    .filter((x) => x.left > 0)
    .slice(0, MAX_NEEDS)
    .map(({ r, left }) => ({ id: r.task.id, kind: r.task.kind, label: label(r), date: r.task.taskDate, timeWindow: r.task.timeWindow, daysLeft: daysBetween(today, r.task.taskDate), placesLeft: left, href: href(r), askHref: `${href(r)}#ask-roster` }));
  const weekEnd = addDays(today, 6);
  const days = new Map<string, WeekDay>();
  for (const r of live) {
    if (r.task.taskDate > weekEnd || placesLeft(r.task, counts.get(r.task.id) ?? 0) > 0) continue;
    const day = days.get(r.task.taskDate) ?? { date: r.task.taskDate, items: [] };
    day.items.push({ id: r.task.id, kind: r.task.kind, label: label(r), timeWindow: r.task.timeWindow, href: href(r) });
    days.set(r.task.taskDate, day);
  }
  return { needsSomeone, thisWeek: [...days.values()] };
}

/** The actor's own open "for Mitzvah Corps" steps, with the clergy's logistics line (never from a restricted item). */
export async function listMySteps(db: Db, actor: Actor): Promise<HomeStep[]> {
  if (!canManageRoster(actor)) deny();
  const rows = await db
    .select({ id: followUps.id, person: followUps.displayName, sfContactId: followUps.sfContactId, title: followUps.title, dueDate: followUps.dueDate, link: followUps.link, corpsNote: sql<string | null>`case when ${careItems.restricted} then null else ${careItems.corpsNote} end` })
    .from(followUps)
    .leftJoin(careItems, eq(careItems.id, followUps.careItemId))
    .where(and(followUpVisibleWhere(actor), eq(followUps.ownerUserId, actor.id), eq(followUps.forLead, true), isNull(followUps.doneAt)))
    .orderBy(asc(followUps.dueDate), asc(followUps.createdAt))
    .limit(30);
  return rows.map((r) => ({ id: r.id, person: r.person ?? "Name not recorded", title: r.title, dueDate: r.dueDate, corpsNote: r.corpsNote, mealsHref: r.link === "meals" ? (r.sfContactId ? `/meals/new?contact=${r.sfContactId}` : "/meals/new") : null }));
}

/** Live meal pages the actor sees that have a night in the next seven days with nobody on it. Null for someone who sees no meal pages. */
async function mealsOpen(db: Db, actor: Actor, today: string): Promise<HomeMeal[] | null> {
  if (!canManageMealPages(actor)) return null;
  const taken = db.select({ id: mealSignups.id }).from(mealSignups).where(and(eq(mealSignups.slotId, mealSlots.id), isNull(mealSignups.cancelledAt)));
  const rows = await db
    .select({ id: mealPages.id, title: mealPages.title, date: mealSlots.date, meal: mealSlots.meal })
    .from(mealSlots)
    .innerJoin(mealPages, eq(mealPages.id, mealSlots.pageId))
    .where(and(mealPageVisibleWhere(actor), eq(mealPages.status, "live"), eq(mealSlots.status, "open"), gte(mealSlots.date, today), lte(mealSlots.date, addDays(today, 7)), sql`not exists (${taken})`))
    .orderBy(asc(mealSlots.date));
  const pages = new Map<string, HomeMeal>();
  for (const r of rows) {
    const page = pages.get(r.id) ?? { id: r.id, title: r.title, openNights: [], href: `/meals/${r.id}` };
    page.openNights.push({ date: r.date, meal: r.meal });
    pages.set(r.id, page);
  }
  return [...pages.values()];
}

/** Claims, cancellations, done notes and meal sign-ups in the last 48 hours, newest first, from rows with their own timestamps. */
async function changesSince(db: Db, actor: Actor, now: Date): Promise<Change[]> {
  const since = new Date(now.getTime() - CHANGE_HOURS * 3_600_000);
  const out: Change[] = [];
  const claims = await db
    .select({ claim: volunteerClaims, task: volunteerTasks, sheet: volunteerGroups.title })
    .from(volunteerClaims)
    .innerJoin(volunteerTasks, eq(volunteerTasks.id, volunteerClaims.taskId))
    .leftJoin(volunteerGroups, eq(volunteerGroups.id, volunteerTasks.groupId))
    .where(and(volunteerTaskVisibleWhere(actor), or(gte(volunteerClaims.createdAt, since), gte(volunteerClaims.cancelledAt, since), gte(volunteerClaims.doneAt, since), gte(volunteerClaims.flaggedAt, since))))
    // Newest event first (Postgres's greatest skips nulls), so a recent change on an old claim is not cut off by the limit.
    .orderBy(desc(sql`greatest(${volunteerClaims.createdAt}, ${volunteerClaims.cancelledAt}, ${volunteerClaims.doneAt}, ${volunteerClaims.flaggedAt})`))
    .limit(100);
  for (const { claim, task, sheet } of claims) {
    const label = task.groupId ? `Shiva for ${sheet ?? task.forLabel}` : task.forLabel;
    const href = task.groupId ? `/volunteers/sheets/${task.groupId}` : `/volunteers/${task.id}`;
    const base = { firstName: claim.firstName, label, href };
    if (claim.createdAt >= since) out.push({ ...base, at: claim.createdAt, kind: "signed_up", note: null });
    if (claim.cancelledAt && claim.cancelledAt >= since) out.push({ ...base, at: claim.cancelledAt, kind: claim.cancelledBy === "poster" ? "removed" : "gave_back", note: null });
    if (claim.doneAt && claim.doneAt >= since) out.push({ ...base, at: claim.doneAt, kind: "done", note: claim.doneNote });
    // Only THAT something went to the rabbis: the words are in the clergy Inbox, never here, and no name is given.
    if (claim.flaggedAt && claim.flaggedAt >= since) out.push({ ...base, firstName: null, at: claim.flaggedAt, kind: "flagged", note: null });
  }
  if (canManageMealPages(actor)) {
    const meals = await db
      .select({ s: mealSignups, title: mealPages.title, pageId: mealPages.id })
      .from(mealSignups)
      .innerJoin(mealSlots, eq(mealSlots.id, mealSignups.slotId))
      .innerJoin(mealPages, eq(mealPages.id, mealSlots.pageId))
      .where(and(mealPageVisibleWhere(actor), or(gte(mealSignups.createdAt, since), gte(mealSignups.cancelledAt, since))))
      .limit(100);
    for (const { s, title, pageId } of meals) {
      const base = { firstName: s.firstName, label: title, note: null, href: `/meals/${pageId}` };
      if (s.createdAt >= since) out.push({ ...base, at: s.createdAt, kind: "meal_signed_up" });
      if (s.cancelledAt && s.cancelledAt >= since) out.push({ ...base, at: s.cancelledAt, kind: "meal_cancelled" });
    }
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, MAX_CHANGES);
}

