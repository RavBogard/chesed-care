/**
 * The team view: per person on the care team how much work they hold, and the work that
 * needs someone. Aggregate queries only (one per measure, never one per person or item) and
 * no Salesforce. The restricted rule lives in src/server/access/policy.ts (teamItemWhere,
 * teamFollowUpWhere, teamContactWhere): the viewer's own row counts what they fully see,
 * every other row counts non-restricted work only.
 */
import { and, asc, eq, gte, inArray, isNull, lte, lt, sql } from "drizzle-orm";
import {
  canSeeTeamView,
  deny,
  followUpVisibleWhere,
  mealPageVisibleWhere,
  proposalReviewWhere,
  teamContactWhere,
  teamFollowUpWhere,
  teamItemWhere,
  volunteerTaskVisibleWhere,
  canManageMealPages,
  canPostVolunteerTasks,
  type Actor,
  type Role,
} from "@/server/access/policy";
import { personPath } from "@/lib/care-labels";
import { careItems, contactLog, followUps, mealPages, mealSignups, mealSlots, proposals, users, volunteerClaims, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { activeWhere } from "@/server/care/care-items";

export type TeamRow = {
  userId: string;
  name: string;
  role: Role;
  self: boolean;
  openItems: number;
  overdue: number;
  dueThisWeek: number;
  journeyStepsComing: number;
  /** The Chicago day of their last logged contact, or null. */
  lastContact: string | null;
  /** True for every clergy level row (the same neutral line, whatever they hold) except the viewer's own. */
  restrictedNote: boolean;
};

export type NeedsRow = { id: string; label: string; detail: string; href: string; /** An unassigned follow-up that is for Mitzvah Corps. */ forLead?: boolean };

export type TeamOverview = {
  today: string;
  people: TeamRow[];
  noOwner: NeedsRow[];
  unassignedFollowUps: NeedsRow[];
  inboxWaiting: NeedsRow[];
  volunteerTasks: NeedsRow[];
  mealNights: NeedsRow[];
};

export const INBOX_WAIT_DAYS = 2;
export const VOLUNTEER_LOOKAHEAD_DAYS = 3;
export const MEAL_LOOKAHEAD_DAYS = 3;
const LIST_MAX = 50;

const CARE_ROLES: Role[] = ["owner", "clergy", "caregiver"];
const isClergyRole = (r: Role) => r === "owner" || r === "clergy";

function personHref(r: { sfContactId: string | null; outsidePersonId: string | null }): string {
  return r.outsidePersonId || r.sfContactId ? personPath(r) : "/care";
}

export async function getTeamOverview(db: Db, actor: Actor, now: Date = new Date()): Promise<TeamOverview> {
  if (!canSeeTeamView(actor)) deny();
  const today = chicagoToday(now);
  const week = addDays(today, 6);
  const journeyEnd = addDays(today, 13);
  const waitCutoff = new Date(now.getTime() - INBOX_WAIT_DAYS * 86_400_000);
  const volEnd = addDays(today, VOLUNTEER_LOOKAHEAD_DAYS);
  const mealEnd = addDays(today, MEAL_LOOKAHEAD_DAYS);

  const [members, itemRows, fuRows, contactRows, noOwner, unassigned, inbox, tasks, meals] = await Promise.all([
    db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(and(eq(users.active, true), inArray(users.role, CARE_ROLES))).orderBy(asc(users.name), asc(users.email)),
    db
      .select({ owner: careItems.ownerUserId, n: sql<number>`count(*)::int` })
      .from(careItems)
      .where(and(teamItemWhere(actor), activeWhere(today)))
      .groupBy(careItems.ownerUserId),
    db
      .select({
        owner: followUps.ownerUserId,
        overdue: sql<number>`(count(*) filter (where ${followUps.dueDate} < ${today}))::int`,
        week: sql<number>`(count(*) filter (where ${followUps.dueDate} >= ${today} and ${followUps.dueDate} <= ${week}))::int`,
        steps: sql<number>`(count(*) filter (where ${followUps.journeyId} is not null and ${followUps.dueDate} >= ${today} and ${followUps.dueDate} <= ${journeyEnd}))::int`,
      })
      .from(followUps)
      .where(and(teamFollowUpWhere(actor), isNull(followUps.doneAt)))
      .groupBy(followUps.ownerUserId),
    db
      .select({ author: contactLog.authorUserId, last: sql<Date>`max(${contactLog.occurredAt})` })
      .from(contactLog)
      .where(teamContactWhere(actor))
      .groupBy(contactLog.authorUserId),
    // An item held by someone who is no longer here. (care_items.owner_user_id is never null.)
    db
      .select({ id: careItems.id, name: careItems.displayName, sfContactId: careItems.sfContactId, outsidePersonId: careItems.outsidePersonId, since: careItems.createdAt })
      .from(careItems)
      .innerJoin(users, eq(users.id, careItems.ownerUserId))
      .where(and(teamItemWhere(actor), activeWhere(today), eq(users.active, false)))
      .orderBy(asc(careItems.createdAt))
      .limit(LIST_MAX),
    db
      .select({ id: followUps.id, name: followUps.displayName, title: followUps.title, due: followUps.dueDate, forLead: followUps.forLead, owner: followUps.ownerUserId, sfContactId: followUps.sfContactId, outsidePersonId: followUps.outsidePersonId, careItemId: followUps.careItemId })
      .from(followUps)
      .where(
        and(
          // Unassigned work on the viewer's own restricted item shows for them, and only for them.
          followUpVisibleWhere(actor),
          sql`(${followUps.careItemId} is null or exists (select 1 from ${careItems} where ${careItems.id} = ${followUps.careItemId} and (not ${careItems.restricted} or ${careItems.ownerUserId} = ${actor.id})))`,
          isNull(followUps.doneAt),
          sql`(${followUps.ownerUserId} is null or (${followUps.forLead} and not exists (select 1 from ${users} where ${users.id} = ${followUps.ownerUserId} and ${users.role} = 'lead' and ${users.active})))`,
        ),
      )
      .orderBy(asc(followUps.dueDate))
      .limit(LIST_MAX),
    db
      .select({ id: proposals.id, channel: proposals.channel, createdAt: proposals.createdAt })
      .from(proposals)
      .where(and(eq(proposals.status, "pending"), proposalReviewWhere(actor), lt(proposals.createdAt, waitCutoff)))
      .orderBy(asc(proposals.createdAt))
      .limit(LIST_MAX),
    canPostVolunteerTasks(actor)
      ? db
          .select({ id: volunteerTasks.id, groupId: volunteerTasks.groupId, kind: volunteerTasks.kind, forLabel: volunteerTasks.forLabel, date: volunteerTasks.taskDate })
          .from(volunteerTasks)
          .where(
            and(
              volunteerTaskVisibleWhere(actor),
              eq(volunteerTasks.status, "open"),
              gte(volunteerTasks.taskDate, today),
              lte(volunteerTasks.taskDate, volEnd),
              sql`not exists (select 1 from ${volunteerClaims} where ${volunteerClaims.taskId} = ${volunteerTasks.id} and ${volunteerClaims.cancelledAt} is null)`,
            ),
          )
          .orderBy(asc(volunteerTasks.taskDate))
          .limit(LIST_MAX)
      : Promise.resolve([]),
    canManageMealPages(actor)
      ? db
          .select({ id: mealPages.id, title: mealPages.title, nights: sql<number>`count(*)::int`, first: sql<string>`min(${mealSlots.date})` })
          .from(mealSlots)
          .innerJoin(mealPages, eq(mealPages.id, mealSlots.pageId))
          .where(
            and(
              mealPageVisibleWhere(actor),
              eq(mealPages.status, "live"),
              eq(mealSlots.status, "open"),
              gte(mealSlots.date, today),
              lte(mealSlots.date, mealEnd),
              sql`not exists (select 1 from ${mealSignups} where ${mealSignups.slotId} = ${mealSlots.id} and ${mealSignups.cancelledAt} is null)`,
            ),
          )
          .groupBy(mealPages.id, mealPages.title)
          .orderBy(sql`min(${mealSlots.date})`)
          .limit(LIST_MAX)
      : Promise.resolve([]),
  ]);

  const items = new Map(itemRows.map((r) => [r.owner, r.n]));
  const fu = new Map(fuRows.map((r) => [r.owner, r]));
  const last = new Map(contactRows.map((r) => [r.author, r.last]));
  const people: TeamRow[] = members.map((m) => {
    const f = fu.get(m.id);
    const at = last.get(m.id);
    return {
      userId: m.id,
      name: m.name ?? m.email,
      role: m.role,
      self: m.id === actor.id,
      openItems: items.get(m.id) ?? 0,
      overdue: f?.overdue ?? 0,
      dueThisWeek: f?.week ?? 0,
      journeyStepsComing: f?.steps ?? 0,
      lastContact: at ? chicagoToday(new Date(at)) : null,
      restrictedNote: isClergyRole(m.role) && m.id !== actor.id,
    };
  });

  const age = (d: Date) => `Since ${chicagoToday(d)}`;
  return {
    today,
    people,
    noOwner: noOwner.map((r) => ({ id: r.id, label: r.name, detail: `Held by someone no longer on the team. ${age(r.since)}.`, href: personHref(r) })),
    unassignedFollowUps: unassigned.map((r) => ({
      id: r.id,
      label: r.name ?? "Name not recorded",
      detail: `${r.title} · due ${r.due} · ${r.forLead ? "For Mitzvah Corps, no lead" : "No one assigned"}`,
      href: personHref(r),
      forLead: r.forLead,
    })),
    inboxWaiting: inbox.map((r) => ({ id: r.id, label: `Arrived ${chicagoToday(r.createdAt)}`, detail: `By ${r.channel}`, href: "/inbox" })),
    volunteerTasks: tasks.map((r) => ({ id: r.id, label: `${r.kind.replace("_", " ")} for ${r.forLabel}`, detail: `On ${r.date}, no one has taken it`, href: r.groupId ? `/volunteers/sheets/${r.groupId}` : `/volunteers/${r.id}` })),
    mealNights: meals.map((r) => ({ id: r.id, label: r.title, detail: `${r.nights} ${r.nights === 1 ? "night" : "nights"} still open, from ${r.first}`, href: `/meals/${r.id}` })),
  };
}
