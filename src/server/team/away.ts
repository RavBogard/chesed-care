/**
 * "I'm away" and cover. A clergy member sets a window (Chicago days, inclusive) and optionally a colleague who covers.
 * Everything here is computed at READ time from today's date: nothing is reassigned, no ownership changes, and when the
 * window ends everything reverts by itself (no job). The one thing a job does is the day-before notice to the coverer.
 *
 * The restricted rule for the coverer's section: the covered follow-ups are read through followUpVisibleWhere for the
 * COVERER, so a follow-up on a restricted item the coverer is shut out of is never returned. It stays with its holder.
 */
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { canCover, canSetAway, canUseAgenda, deny, followUpVisibleWhere, type Actor } from "@/server/access/policy";
import { auditRestrictedReadsByItem, writeAudit } from "@/server/care/audit";
import { dateField, InvalidInput, uuidField } from "@/server/care/validate";
import { followUps, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { daysBetween, monthDay } from "@/lib/format";
import { addDays, chicagoToday } from "@/server/lifecycle/window";

export type Away = { userId: string; name: string; from: string; until: string; coverUserId: string | null; coverName: string | null };

/** The longest stretch one setting may cover. */
export const AWAY_MAX_DAYS = 120;

type AwayRow = { id: string; name: string | null; email: string; from: string | null; until: string | null; cover: string | null; role: Actor["role"]; active: boolean };

async function awayRows(db: Db, where: ReturnType<typeof and>): Promise<AwayRow[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email, from: users.awayFrom, until: users.awayUntil, cover: users.coverUserId, role: users.role, active: users.active })
    .from(users)
    .where(where);
}

/** Everyone away today, with a coverer only when that person is still an active clergy level user. Empty when the columns are not there yet. */
export async function listAwayToday(db: Db, today: string): Promise<Away[]> {
  try {
    const rows = await awayRows(db, and(eq(users.active, true), lte(users.awayFrom, today), gte(users.awayUntil, today)));
    if (rows.length === 0) return [];
    const people = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active }).from(users);
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => {
      const c = r.cover ? byId.get(r.cover) : undefined;
      const ok = c && canCover(c) && c.id !== r.id;
      return { userId: r.id, name: r.name ?? r.email, from: r.from!, until: r.until!, coverUserId: ok ? c.id : null, coverName: ok ? (c.name ?? c.email) : null };
    });
  } catch (error) {
    console.error("Away: unavailable", error instanceof Error ? error.name : "unknown");
    return [];
  }
}

/** The away list for a screen: clergy level only (others get nothing). */
export async function awayLines(db: Db, actor: Actor, today: string): Promise<Away[]> {
  if (!canUseAgenda(actor)) return [];
  return listAwayToday(db, today);
}

/** "Name is away until Friday. Other is covering." Pure. */
export function awayLine(a: Away, today: string): string {
  const n = daysBetween(today, a.until);
  const until = n <= 6 ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${a.until}T12:00:00Z`)) : monthDay(a.until);
  return `${a.name} is away until ${until}.${a.coverName ? ` ${a.coverName} is covering.` : ""}`;
}

/** Away person id -> their coverer's id, for the people away today who have a valid coverer. */
export function coverMap(away: Away[]): Map<string, string> {
  return new Map(away.flatMap((a) => (a.coverUserId ? [[a.userId, a.coverUserId] as [string, string]] : [])));
}

/** The person to suggest in place of `userId`: their coverer while they are away, otherwise themselves. */
export function suggestInstead(userId: string, cover: Map<string, string>): string {
  return cover.get(userId) ?? userId;
}

/** Set "I'm away" (oneself, or anyone as the owner). The coverer must be another active clergy level user. */
/**
 * The first day in a window on which every active clergy level person is marked away, or
 * null. Someone who is away is told nothing urgent, so on such a day an urgent report would
 * reach nobody. Pure, so the rule can be tested on its own.
 */
export function firstDayNobodyIsHere(people: { awayFrom: string | null; awayUntil: string | null }[], from: string, until: string): string | null {
  if (people.length === 0) return null;
  for (let day = from; day <= until; day = addDays(day, 1)) {
    if (people.every((p) => p.awayFrom !== null && p.awayUntil !== null && p.awayFrom <= day && day <= p.awayUntil)) return day;
  }
  return null;
}

/** After a change to who is away: the first day from today on which nobody on the clergy team is here, if any. */
async function gapAfterChange(db: Db, from: string, until: string): Promise<string | null> {
  const rows = await db.select({ role: users.role, active: users.active, awayFrom: users.awayFrom, awayUntil: users.awayUntil }).from(users);
  return firstDayNobodyIsHere(rows.filter((r) => canCover(r)), from, until);
}

export async function setAway(db: Db, actor: Actor, userId: unknown, input: { from: unknown; until: unknown; coverUserId?: unknown }, now: Date = new Date()): Promise<{ nobodyHereFrom: string | null }> {
  const id = uuidField(userId, "userId");
  if (!canSetAway(actor, id)) deny();
  const from = dateField(input.from, "from");
  const until = dateField(input.until, "until");
  const today = chicagoToday(now);
  if (until < from || until < today || daysBetween(from, until) > AWAY_MAX_DAYS) throw new InvalidInput("until");
  let cover: string | null = null;
  if (input.coverUserId !== undefined && input.coverUserId !== null && input.coverUserId !== "") {
    cover = uuidField(input.coverUserId, "coverUserId");
    const [c] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, cover)).limit(1);
    if (!c || !canCover(c) || cover === id) throw new InvalidInput("coverUserId");
  }
  const [target] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, id)).limit(1);
  if (!target || !canCover(target)) throw new InvalidInput("userId");
  await db.update(users).set({ awayFrom: from, awayUntil: until, coverUserId: cover }).where(eq(users.id, id));
  await writeAudit(db, actor, "away.set", "user", id, { userId: cover ?? undefined });
  return { nobodyHereFrom: await gapAfterChange(db, from < today ? today : from, until) };
}

export async function clearAway(db: Db, actor: Actor, userId: unknown): Promise<void> {
  const id = uuidField(userId, "userId");
  if (!canSetAway(actor, id)) deny();
  await db.update(users).set({ awayFrom: null, awayUntil: null, coverUserId: null }).where(eq(users.id, id));
  await writeAudit(db, actor, "away.clear", "user", id);
}

export type CoveredFollowUp = typeof followUps.$inferSelect;
export type Covering = { away: Away; followUps: CoveredFollowUp[] };

/**
 * "Covering for X" on Today: for each colleague away today who named the actor, their open follow-ups due inside the window
 * that the ACTOR can already see (followUpVisibleWhere for the actor). Restricted follow-ups they are shut out of are not
 * returned; ownership is untouched.
 */
export async function getCovering(db: Db, actor: Actor, today: string): Promise<Covering[]> {
  if (!canUseAgenda(actor)) return [];
  const mine = (await listAwayToday(db, today)).filter((a) => a.coverUserId === actor.id);
  const out: Covering[] = [];
  for (const away of mine) {
    const rows = await db
      .select()
      .from(followUps)
      .where(and(followUpVisibleWhere(actor), eq(followUps.ownerUserId, away.userId), isNull(followUps.doneAt), gte(followUps.dueDate, away.from), lte(followUps.dueDate, away.until)))
      .orderBy(asc(followUps.dueDate), asc(followUps.createdAt));
    await auditRestrictedReadsByItem(db, actor, rows.map((f) => f.careItemId));
    out.push({ away, followUps: rows });
  }
  return out;
}

/** People whose window starts tomorrow and who named a coverer: for the day-before notice. */
export async function startingTomorrow(db: Db, now: Date): Promise<{ userId: string; coverUserId: string; from: string }[]> {
  const tomorrow = addDays(chicagoToday(now), 1);
  try {
    const rows = await awayRows(db, and(eq(users.active, true), eq(users.awayFrom, tomorrow), sql`${users.coverUserId} is not null`));
    return rows.map((r) => ({ userId: r.id, coverUserId: r.cover!, from: tomorrow }));
  } catch {
    return [];
  }
}

export type AwaySetting = { userId: string; name: string; self: boolean; away: { from: string; until: string; coverUserId: string | null } | null };

/** For Settings: the people whose "away" the actor may set (themselves; every clergy level user for the owner), and who could cover. */
export async function getAwaySettings(db: Db, actor: Actor): Promise<{ people: AwaySetting[]; coverChoices: { id: string; name: string }[] }> {
  if (!canUseAgenda(actor)) return { people: [], coverChoices: [] };
  const clergy = (await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active }).from(users)).filter(canCover);
  let windows = new Map<string, { from: string; until: string; coverUserId: string | null }>();
  try {
    const rows = await awayRows(db, and(eq(users.active, true)));
    windows = new Map(rows.filter((r) => r.from && r.until).map((r) => [r.id, { from: r.from!, until: r.until!, coverUserId: r.cover }]));
  } catch {
    // The columns are not there yet: the form still shows, empty.
  }
  const nameOf = (u: { name: string | null; email: string }) => u.name ?? u.email;
  return {
    people: clergy.filter((u) => canSetAway(actor, u.id)).map((u) => ({ userId: u.id, name: nameOf(u), self: u.id === actor.id, away: windows.get(u.id) ?? null })).sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name)),
    coverChoices: clergy.map((u) => ({ id: u.id, name: nameOf(u) })),
  };
}
