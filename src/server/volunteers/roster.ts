/**
 * The Mitzvah Corps roster, signed-in side: who has said they will help, what they can do, and who was asked
 * lately. Every function takes the acting user and asks the access policy (canManageRoster): owner, clergy and
 * the lead. Contacts are returned only by listRoster (the roster screen) and prepareAsk (the "copy" and "open
 * in my mail app" step). There is no export. Nothing here sends anything, except emailAsk, which emails the members a coordinator ticked.
 */
import { and, eq, inArray, isNotNull, isNull, lte, max, or, sql, type SQL } from "drizzle-orm";
import { canManageRoster, deny, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { InvalidInput, NotFound, uuidList, uuidOrNotFound } from "@/server/care/validate";
import { corpsAsks, corpsMembers, mealSignups, mealSlots, visitingList, volunteerClaims, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { newToken, tokenHash } from "@/server/meals/tokens";
import { listPastHelpers } from "@/server/meals/slots";
import { emailStatus } from "@/server/email/config";
import type { EmailDeps } from "@/server/email/send";
import { ASK_SUBJECT, askBody, mailtoLinks, safeEmails, safeNumbers, smsLinks } from "@/lib/ask-links";
import { normalizeContact, parse } from "./input";
import { PENDING_DAYS } from "./join";
import { getVolunteerSheet, getVolunteerTask, listAskAgain } from "./organiser";
import { EMAIL_ASK_MAX, notifyMembers } from "./notify";
import { monthsBefore } from "./purge";
import { forgetStopped, recordStopped, stoppedAmong } from "./stopped";
import { CAN_DO, CAN_DO_FOR_KIND, HOW_OFTEN_DAYS, type CanDo } from "@/lib/can-do";
import { contactsOf, memberInput, pauseInput } from "./roster-input";

export type Member = typeof corpsMembers.$inferSelect;
export type EffectiveStatus = "active" | "paused" | "left" | "pending";

/** A member is active again on the day they were paused until; the daily job makes it permanent. */
export function effectiveStatus(m: Pick<Member, "status" | "pausedUntil">, today: string): EffectiveStatus {
  if (m.status === "paused" && m.pausedUntil !== null && m.pausedUntil <= today) return "active";
  return m.status;
}

export type MemberView = {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  mobile: string | null;
  canDo: string[];
  availability: string | null;
  area: string | null;
  howOften: Member["howOften"];
  preferContact: Member["preferContact"];
  coordinatorNotes: string | null;
  status: EffectiveStatus;
  pausedUntil: string | null;
  source: Member["source"];
  joinedOn: string;
  lastHelpedOn: string | null;
  helpedLast12Months: number;
  contactDeleted: boolean;
  stoppedBy: Member["stoppedBy"];
  leftAt: Date | null;
  /** A /join submission for this contact since: for a coordinator to act on. Nothing on the member changed. */
  askedToJoinAgainAt: Date | null;
};

// ─── how often each person has helped ───────────────────────────────────────────────────

type Keyed = Pick<Member, "id" | "emailKey" | "mobileKey" | "lastHelpedOn" | "helpedCount">;
export type Helped = { last: string | null; count12: number };

/**
 * Last helped date and times helped in the last twelve months, by normalised contact, from volunteer claims
 * (not cancelled, on a task that was not cancelled, whose date has gone by) and meal sign-ups (not cancelled).
 */
export async function helpStats(db: Db, members: Keyed[], today: string): Promise<Map<string, Helped>> {
  const out = new Map<string, Helped>(members.map((m) => [m.id, { last: m.lastHelpedOn, count12: 0 }]));
  const keys = members.flatMap((m) => [m.emailKey, m.mobileKey]).filter((k): k is string => k !== null);
  if (keys.length === 0) return out;
  const since = monthsBefore(today, 12);
  const claims = await db
    .select({ key: volunteerClaims.contactKey, date: volunteerTasks.taskDate })
    .from(volunteerClaims)
    .innerJoin(volunteerTasks, eq(volunteerTasks.id, volunteerClaims.taskId))
    .where(and(inArray(volunteerClaims.contactKey, keys), isNull(volunteerClaims.cancelledAt), sql`${volunteerTasks.status} <> 'cancelled'`, lte(volunteerTasks.taskDate, today)));
  const meals = await db
    .select({ key: mealSignups.email, date: mealSlots.date })
    .from(mealSignups)
    .innerJoin(mealSlots, eq(mealSlots.id, mealSignups.slotId))
    .where(and(inArray(mealSignups.email, keys), isNull(mealSignups.cancelledAt), lte(mealSlots.date, today)));
  const events = new Map<string, string[]>();
  for (const r of [...claims, ...meals]) if (r.key) events.set(r.key, [...(events.get(r.key) ?? []), r.date]);
  for (const m of members) {
    const dates = [m.emailKey, m.mobileKey].flatMap((k) => (k ? (events.get(k) ?? []) : []));
    const entry = out.get(m.id)!;
    for (const d of dates) {
      if (!entry.last || d > entry.last) entry.last = d;
      if (d >= since) entry.count12++;
    }
  }
  return out;
}

const view = (m: Member, today: string, h: Helped | undefined): MemberView => ({
  id: m.id,
  firstName: m.firstName,
  lastName: m.lastName,
  email: m.email,
  mobile: m.mobile,
  canDo: m.canDo,
  availability: m.availability,
  area: m.area,
  howOften: m.howOften,
  preferContact: m.preferContact,
  coordinatorNotes: m.coordinatorNotes,
  status: effectiveStatus(m, today),
  pausedUntil: m.status === "paused" ? m.pausedUntil : null,
  source: m.source,
  joinedOn: m.joinedOn,
  lastHelpedOn: h?.last ?? m.lastHelpedOn,
  helpedLast12Months: h?.count12 ?? 0,
  contactDeleted: m.contactPurgedAt !== null,
  stoppedBy: m.stoppedBy,
  leftAt: m.leftAt,
  askedToJoinAgainAt: m.askedToJoinAgainAt,
});

// ─── the roster ─────────────────────────────────────────────────────────────────────────

export type RosterFilter = { q?: unknown; can?: unknown; status?: unknown };

/** The roster for its screen: contacts included. Filter by name or area, by what they can do, and by status. */
export async function listRoster(db: Db, actor: Actor, filter: RosterFilter = {}, now: Date = new Date()): Promise<MemberView[]> {
  if (!canManageRoster(actor)) deny();
  const today = chicagoToday(now);
  const rows = await db.select().from(corpsMembers).orderBy(corpsMembers.firstName, corpsMembers.lastName);
  const q = typeof filter.q === "string" ? filter.q.trim().toLowerCase().slice(0, 80) : "";
  const can = typeof filter.can === "string" && (CAN_DO as readonly string[]).includes(filter.can) ? filter.can : null;
  const status = filter.status === "active" || filter.status === "paused" || filter.status === "left" ? filter.status : null;
  const kept = rows.filter((m) => {
    if (status && effectiveStatus(m, today) !== status) return false;
    if (can && !m.canDo.includes(can)) return false;
    if (q && ![m.firstName, m.lastName ?? "", m.area ?? ""].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
  const stats = await helpStats(db, kept, today);
  return kept.map((m) => view(m, today, stats.get(m.id)));
}

async function load(db: Db, actor: Actor, id: unknown): Promise<Member> {
  if (!canManageRoster(actor)) deny();
  const [row] = await db.select().from(corpsMembers).where(eq(corpsMembers.id, uuidOrNotFound(id))).limit(1);
  if (!row) throw new NotFound();
  return row;
}

/** Another member who has any of these contact keys. */
async function holderOf(db: Db, keys: { emailKey: string | null; mobileKey: string | null }, exceptId?: string): Promise<Member | null> {
  const any = [keys.emailKey ? eq(corpsMembers.emailKey, keys.emailKey) : undefined, keys.mobileKey ? eq(corpsMembers.mobileKey, keys.mobileKey) : undefined].filter((c): c is SQL => c !== undefined);
  if (any.length === 0) return null;
  const rows = await db.select().from(corpsMembers).where(or(...any));
  return rows.find((r) => r.id !== exceptId) ?? null;
}

/** A coordinator adds a member. The same person (by email or mobile) is not added twice. */
export async function addMember(db: Db, actor: Actor, input: unknown, now: Date = new Date()): Promise<MemberView> {
  if (!canManageRoster(actor)) deny();
  const v = parse(memberInput, input);
  const contacts = contactsOf(v);
  if (!contacts) throw new InvalidInput("contact");
  if (await holderOf(db, contacts)) throw new InvalidInput("contact");
  // Someone who stopped is never added again by hand: they ask through /join and a coordinator confirms it there.
  if ((await stoppedAmong(db, [contacts.emailKey, contacts.mobileKey].filter((k): k is string => k !== null))).size > 0) throw new InvalidInput("contact");
  const today = chicagoToday(now);
  const row = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(corpsMembers)
      .values({ firstName: v.firstName, lastName: v.lastName, ...contacts, canDo: v.canDo, availability: v.availability ?? null, area: v.area ?? null, howOften: v.howOften ?? null, preferContact: v.preferContact ?? null, coordinatorNotes: v.coordinatorNotes ?? null, source: "coordinator", joinedOn: today, consentAt: now, stopTokenHash: tokenHash(newToken()) })
      .returning();
    await writeAudit(tx, actor, "corps_member.add", "corps_member", m.id, { memberId: m.id, source: "coordinator" });
    return m;
  });
  return view(row, today, undefined);
}

/** Change a member's details. Their status is changed by the status functions below. */
export async function updateMember(db: Db, actor: Actor, id: unknown, input: unknown, now: Date = new Date()): Promise<MemberView> {
  const member = await load(db, actor, id);
  if (member.contactPurgedAt) throw new InvalidInput("status");
  const v = parse(memberInput, input);
  const contacts = contactsOf(v);
  if (!contacts) throw new InvalidInput("contact");
  if (await holderOf(db, contacts, member.id)) throw new InvalidInput("contact");
  const row = await db.transaction(async (tx) => {
    const [m] = await tx
      .update(corpsMembers)
      .set({ firstName: v.firstName, lastName: v.lastName, ...contacts, canDo: v.canDo, availability: v.availability ?? null, area: v.area ?? null, ...(v.howOften !== undefined ? { howOften: v.howOften } : {}), ...(v.preferContact !== undefined ? { preferContact: v.preferContact } : {}), coordinatorNotes: v.coordinatorNotes ?? null })
      .where(eq(corpsMembers.id, member.id))
      .returning();
    await writeAudit(tx, actor, "corps_member.update", "corps_member", m.id, { memberId: m.id });
    return m;
  });
  return view(row, chicagoToday(now), undefined);
}

async function setStatus(db: Db, actor: Actor, id: unknown, set: Partial<typeof corpsMembers.$inferInsert>, to: EffectiveStatus): Promise<void> {
  const member = await load(db, actor, id);
  await db.transaction(async (tx) => {
    await tx.update(corpsMembers).set(set).where(eq(corpsMembers.id, member.id));
    await writeAudit(tx, actor, "corps_member.status", "corps_member", member.id, { memberId: member.id, reason: to });
  });
}

/** Pause until a date in the future: no asks until then, and they are active again that day by themselves. */
export async function pauseMember(db: Db, actor: Actor, id: unknown, until: unknown, now: Date = new Date()): Promise<void> {
  const parsed = pauseInput.safeParse(until);
  if (!parsed.success || parsed.data <= chicagoToday(now)) throw new InvalidInput("pausedUntil");
  const member = await load(db, actor, id);
  if (member.status !== "active") throw new InvalidInput("status");
  await setStatus(db, actor, id, { status: "paused", pausedUntil: parsed.data }, "paused");
  // A paused member is no one's regular visitor.
  await db.update(visitingList).set({ visitorMemberId: null, visitorSetBy: null }).where(eq(visitingList.visitorMemberId, member.id));
}

/** Mark as left: no more asks, "ask me again" ticks are turned off, a hash of their contact is kept, and their details are deleted 30 days later. */
export async function markMemberLeft(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<void> {
  const member = await load(db, actor, id);
  if (member.contactPurgedAt || member.status === "left") return;
  await db.transaction(async (tx) => {
    await tx.update(corpsMembers).set({ status: "left", pausedUntil: null, leftAt: now, stoppedBy: member.stoppedBy === "self" ? "self" : "coordinator" }).where(eq(corpsMembers.id, member.id));
    await tx.update(visitingList).set({ visitorMemberId: null, visitorSetBy: null }).where(eq(visitingList.visitorMemberId, member.id));
    await recordStopped(tx, member);
    await writeAudit(tx, actor, "corps_member.status", "corps_member", member.id, { memberId: member.id, reason: "left" });
  });
}

/** What bringing someone back needs. A person who stopped through their own link: they asked again AND a coordinator confirms. */
function assertMayReturn(member: Member, confirmed: boolean): void {
  if (member.stoppedBy !== "self") return;
  const askedAgain = member.askedToJoinAgainAt !== null && (member.leftAt === null || member.askedToJoinAgainAt > member.leftAt);
  if (!confirmed || !askedAgain) throw new InvalidInput("confirm");
}

async function bringBack(db: Db, actor: Actor, member: Member, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(corpsMembers).set({ status: "active", pausedUntil: null, leftAt: null, stoppedBy: null, askedToJoinAgainAt: null }).where(eq(corpsMembers.id, member.id));
    await forgetStopped(tx, member);
    await writeAudit(tx, actor, "corps_member.status", "corps_member", member.id, { memberId: member.id, reason });
  });
}

/**
 * Back to active. Someone who left by their own stop link comes back only if they have asked to join again since AND
 * the coordinator confirms ("They asked us to stop on <date>. Only bring them back if they have asked to return.").
 * A member whose details were already deleted cannot come back: they are added afresh through the form.
 */
export async function reactivateMember(db: Db, actor: Actor, id: unknown, opts: { confirmed?: boolean } = {}): Promise<void> {
  const member = await load(db, actor, id);
  if (member.contactPurgedAt || member.status === "pending") throw new InvalidInput("status");
  assertMayReturn(member, opts.confirmed === true);
  await bringBack(db, actor, member, "active");
}

/** A coordinator accepts someone the form made: from then on they can be asked. Someone who had stopped needs the same confirmation as reactivating. */
export async function acceptMember(db: Db, actor: Actor, id: unknown, opts: { confirmed?: boolean } = {}): Promise<void> {
  const member = await load(db, actor, id);
  if (member.status !== "pending") throw new InvalidInput("status");
  assertMayReturn(member, opts.confirmed === true);
  await bringBack(db, actor, member, "accepted");
}

/** Accept every pending member who has not stopped before. Returns how many. */
export async function acceptAllPending(db: Db, actor: Actor): Promise<number> {
  if (!canManageRoster(actor)) deny();
  const pending = (await db.select().from(corpsMembers).where(eq(corpsMembers.status, "pending"))).filter((m) => m.stoppedBy !== "self");
  for (const m of pending) await bringBack(db, actor, m, "accepted");
  return pending.length;
}

/** Clear the "asked to join again" flag without bringing anyone back. */
export async function dismissJoinAgain(db: Db, actor: Actor, id: unknown): Promise<void> {
  const member = await load(db, actor, id);
  await db.update(corpsMembers).set({ askedToJoinAgainAt: null }).where(eq(corpsMembers.id, member.id));
}

/**
 * A stop link for one member, shown once: only its hash is kept, so a link already made stops working. A member who already
 * has one is given a new one only when the coordinator chooses to replace it (`replace`).
 */
export async function makeStopLink(db: Db, actor: Actor, id: unknown, replace = false): Promise<{ token: string }> {
  const member = await load(db, actor, id);
  if (member.contactPurgedAt) throw new InvalidInput("status");
  if (member.stopTokenHash && !replace) throw new InvalidInput("replace");
  const token = newToken();
  await db.transaction(async (tx) => {
    await tx.update(corpsMembers).set({ stopTokenHash: tokenHash(token) }).where(eq(corpsMembers.id, member.id));
    await writeAudit(tx, actor, "corps_member.stop_link", "corps_member", member.id, { memberId: member.id });
  });
  return { token };
}

// ─── from "ask me again" ────────────────────────────────────────────────────────────────

export type PastHelperCandidate = { key: string; firstName: string | null; lastName: string | null; email: string | null; mobile: string | null; lastDate: string; from: "volunteer" | "meals" };

/**
 * Past helpers who ticked "ask me again" (volunteer claims and meal sign-ups the actor can see) and are not on the
 * roster, de-duplicated by normalised contact. Someone who left the roster is on it still, so never offered again.
 */
export async function listPastHelperCandidates(db: Db, actor: Actor, now: Date = new Date()): Promise<PastHelperCandidate[]> {
  if (!canManageRoster(actor)) deny();
  const [fromTasks, fromMeals, onRoster] = await Promise.all([listAskAgain(db, actor), listPastHelpers(db, actor, now), db.select({ e: corpsMembers.emailKey, m: corpsMembers.mobileKey }).from(corpsMembers)]);
  const taken = new Set(onRoster.flatMap((r) => [r.e, r.m]).filter((k): k is string => k !== null));
  const byKey = new Map<string, PastHelperCandidate>();
  const put = (c: PastHelperCandidate) => {
    const have = byKey.get(c.key);
    if (!have || c.lastDate > have.lastDate) byKey.set(c.key, c);
  };
  for (const h of fromTasks) {
    const n = normalizeContact(h.contact);
    if (!n) continue;
    const isEmail = h.contact.includes("@");
    put({ key: n.key, firstName: h.firstName, lastName: h.lastName, email: isEmail ? n.contact : null, mobile: isEmail ? null : n.contact, lastDate: h.lastDate, from: "volunteer" });
  }
  for (const h of fromMeals) {
    const n = normalizeContact(h.email);
    if (n) put({ key: n.key, firstName: h.firstName, lastName: h.lastName, email: n.contact, mobile: null, lastDate: h.lastHelped, from: "meals" });
  }
  const stopped = await stoppedAmong(db, [...byKey.keys()]);
  return [...byKey.values()].filter((c) => !taken.has(c.key) && !stopped.has(c.key)).sort((a, b) => b.lastDate.localeCompare(a.lastDate));
}

/** One tap: a past helper becomes a member (what they can do is left for the coordinator to fill in). */
export async function addFromPastHelper(db: Db, actor: Actor, key: unknown, now: Date = new Date()): Promise<MemberView> {
  if (!canManageRoster(actor)) deny();
  if (typeof key !== "string" || key.length === 0 || key.length > 254) throw new NotFound();
  const found = (await listPastHelperCandidates(db, actor, now)).find((c) => c.key === key);
  if (!found) throw new NotFound();
  const contacts = contactsOf(found);
  if (!contacts) throw new NotFound();
  const today = chicagoToday(now);
  const row = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(corpsMembers)
      .values({ firstName: found.firstName?.trim() || "Friend", lastName: found.lastName, ...contacts, canDo: [], source: "ask_again", joinedOn: today, lastHelpedOn: found.lastDate, consentAt: now, stopTokenHash: tokenHash(newToken()) })
      .onConflictDoNothing()
      .returning();
    if (!m) throw new InvalidInput("contact");
    await writeAudit(tx, actor, "corps_member.add", "corps_member", m.id, { memberId: m.id, source: "ask_again" });
    return m;
  });
  return view(row, today, undefined);
}

// ─── asking the roster ──────────────────────────────────────────────────────────────────

export type AskTarget = { taskId: string } | { groupId: string };
export type AskCandidate = { id: string; firstName: string; lastName: string | null; hasEmail: boolean; hasMobile: boolean; lastAsked: Date | null; lastHelpedOn: string | null; helpedLast12Months: number; canDoStated: boolean; preferContact: Member["preferContact"]; /** Asked more recently than they said they would like: they are listed last. */ askedRecently: boolean };

type Target = { kind: keyof typeof CAN_DO_FOR_KIND; needed: string; publicToken: string | null; open: boolean; where: { taskId: string } | { groupId: string } };

async function targetOf(db: Db, actor: Actor, target: AskTarget, now: Date): Promise<Target> {
  if ("groupId" in target) {
    const sheet = await getVolunteerSheet(db, actor, target.groupId, now);
    const open = !sheet.cancelled && sheet.evenings.some((e) => e.status === "open" && !e.past);
    return { kind: "shiva_minyan", needed: sheet.evenings[0]?.needed ?? "", publicToken: sheet.publicToken, open, where: { groupId: sheet.id } };
  }
  const task = await getVolunteerTask(db, actor, target.taskId, now);
  return { kind: task.kind, needed: task.needed, publicToken: task.publicToken, open: task.status === "open" && !task.past, where: { taskId: task.id } };
}

/** Members who can be asked about this task or sheet: active, able to do its kind, least recently asked first. No contacts. */
export async function listAskCandidates(db: Db, actor: Actor, target: AskTarget, now: Date = new Date()): Promise<AskCandidate[]> {
  if (!canManageRoster(actor)) deny();
  const t = await targetOf(db, actor, target, now);
  const today = chicagoToday(now);
  const want: CanDo = CAN_DO_FOR_KIND[t.kind];
  const rows = (await db.select().from(corpsMembers)).filter((m) => effectiveStatus(m, today) === "active" && (m.canDo.length === 0 || m.canDo.includes(want)));
  const asked = rows.length ? await db.select({ id: corpsAsks.memberId, last: max(corpsAsks.askedAt) }).from(corpsAsks).where(inArray(corpsAsks.memberId, rows.map((r) => r.id))).groupBy(corpsAsks.memberId) : [];
  const lastAsked = new Map(asked.map((a) => [a.id, a.last]));
  const stats = await helpStats(db, rows, today);
  const recently = (m: Member, last: Date | null) => m.howOften !== null && last !== null && now.getTime() - last.getTime() < HOW_OFTEN_DAYS[m.howOften] * 86_400_000;
  return rows
    .map((m) => ({ id: m.id, firstName: m.firstName, lastName: m.lastName, hasEmail: m.email !== null, hasMobile: m.mobile !== null, lastAsked: lastAsked.get(m.id) ?? null, lastHelpedOn: stats.get(m.id)?.last ?? null, helpedLast12Months: stats.get(m.id)?.count12 ?? 0, canDoStated: m.canDo.length > 0, preferContact: m.preferContact, askedRecently: recently(m, lastAsked.get(m.id) ?? null) }))
    .sort((a, b) => Number(a.askedRecently) - Number(b.askedRecently) || (a.lastAsked?.getTime() ?? -Infinity) - (b.lastAsked?.getTime() ?? -Infinity) || a.firstName.localeCompare(b.firstName));
}

export type AskPrepared = { count: number; emails: string[]; mobiles: string[]; mailto: string[]; /** One text link per person: never a group text, which would show everyone every number. */ texts: { name: string; href: string }[]; body: string };

/**
 * The step after ticking people: records that each was asked (date and task, nothing said), and returns what the
 * coordinator needs to send it from their own phone or mail app. Nothing is sent. The words are the app's: the
 * task's public text and its public link only. Members who are not active are left out silently.
 */
/** The checks every way of asking shares: the policy, the target is open, and the ticked members who may be asked now. */
async function resolveAsk(db: Db, actor: Actor, target: AskTarget, memberIds: unknown, origin: string, now: Date, max = 200) {
  if (!canManageRoster(actor)) deny();
  const ids = uuidList(memberIds, "members", max);
  if (ids.length === 0) throw new InvalidInput("members");
  const t = await targetOf(db, actor, target, now);
  if (!t.open || !t.publicToken || !origin) throw new InvalidInput("status");
  const today = chicagoToday(now);
  const members = (await db.select().from(corpsMembers).where(inArray(corpsMembers.id, ids))).filter((m) => effectiveStatus(m, today) === "active" && m.contactPurgedAt === null);
  if (members.length === 0) throw new InvalidInput("members");
  const url = "groupId" in t.where ? `${origin}/v/s/${t.publicToken}` : `${origin}/v/${t.publicToken}`;
  return { t, members, today, body: askBody(t.needed, url) };
}

async function recordAsk(db: Db, actor: Actor, t: Target, members: Member[], now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(corpsAsks).values(members.map((m) => ({ memberId: m.id, askedBy: actor.id, askedAt: now, ...t.where })));
    await writeAudit(tx, actor, "corps_member.ask", "corps_member", members[0].id, { count: members.length, ...("taskId" in t.where ? { volunteerTaskId: t.where.taskId } : { volunteerGroupId: t.where.groupId }) });
  });
}

export async function prepareAsk(db: Db, actor: Actor, target: AskTarget, memberIds: unknown, origin: string, now: Date = new Date()): Promise<AskPrepared> {
  const { t, members, body } = await resolveAsk(db, actor, target, memberIds, origin, now);
  await recordAsk(db, actor, t, members, now);
  const emails = safeEmails(members.flatMap((m) => (m.email ? [m.email] : [])));
  const mobiles = safeNumbers(members.flatMap((m) => (m.mobile ? [m.mobile] : [])));
  const texts = members.flatMap((m) => {
    const [href] = m.mobile ? smsLinks([m.mobile], body) : [];
    return href ? [{ name: m.firstName, href }] : [];
  });
  return { count: members.length, emails, mobiles, mailto: mailtoLinks(emails, ASK_SUBJECT, body), texts, body };
}

export type EmailAsked = { configured: boolean; sent: number; noEmail: number; notSent: number };

/**
 * "Send from CRC Care": the same checks and the same record as prepareAsk (only people who may be asked, an open task or
 * sheet), then one email to each chosen member who has an address, at most 60 people a press. Only members who were actually emailed are recorded as
 * asked, and nothing is recorded or sent when email is not set up. Counts only come back.
 */
export async function emailAsk(db: Db, actor: Actor, target: AskTarget, memberIds: unknown, origin: string, now: Date = new Date(), deps?: EmailDeps): Promise<EmailAsked> {
  const { t, members, today, body } = await resolveAsk(db, actor, target, memberIds, origin, now, EMAIL_ASK_MAX);
  if (!emailStatus(deps?.env).configured) return { configured: false, sent: 0, noEmail: 0, notSent: 0 };
  const ref = `${"taskId" in t.where ? t.where.taskId : t.where.groupId}:${today}`;
  const result = await notifyMembers(members, { subject: ASK_SUBJECT, body }, "email", { db, origin, ref, deps: { ...deps, now } });
  if (result.status === "done" && result.sentIds.length > 0) {
    // Only people who were actually emailed are noted as asked.
    const emailed = new Set(result.sentIds);
    await recordAsk(db, actor, t, members.filter((m) => emailed.has(m.id)), now);
  }
  return result.status === "done" ? { configured: true, sent: result.sent, noEmail: result.noEmail, notSent: result.notSent } : { configured: false, sent: 0, noEmail: 0, notSent: 0 };
}

// ─── upkeep, for the daily job ──────────────────────────────────────────────────────────

/** How long a member's details are kept after they leave. */
export const LEFT_RETENTION_DAYS = 30;

/**
 * Daily: members paused until today or earlier become active; members who left 30 or more days ago lose their
 * contact details, last name, availability, area and notes (the row keeps the first name and a count of times
 * helped); last-helped dates are refreshed from claims and meal sign-ups. No actor; counts only.
 */
export async function rosterUpkeep(db: Db, now: Date = new Date()): Promise<{ unpaused: number; purged: number; refreshed: number; pendingDeleted: number }> {
  const today = chicagoToday(now);
  const unpaused = await db.update(corpsMembers).set({ status: "active", pausedUntil: null }).where(and(eq(corpsMembers.status, "paused"), isNotNull(corpsMembers.pausedUntil), lte(corpsMembers.pausedUntil, today))).returning({ id: corpsMembers.id });
  const pendingCutoff = new Date(now.getTime() - PENDING_DAYS * 86_400_000);
  const dropped = await db.delete(corpsMembers).where(and(eq(corpsMembers.status, "pending"), lte(corpsMembers.createdAt, pendingCutoff))).returning({ id: corpsMembers.id });
  const cutoff = new Date(now.getTime() - LEFT_RETENTION_DAYS * 86_400_000);
  const due = await db.select().from(corpsMembers).where(and(eq(corpsMembers.status, "left"), isNull(corpsMembers.contactPurgedAt), lte(corpsMembers.leftAt, cutoff)));
  const dueStats = await helpStats(db, due, today);
  for (const m of due) {
    await db.update(visitingList).set({ visitorMemberId: null, visitorSetBy: null }).where(eq(visitingList.visitorMemberId, m.id));
    await db
      .update(corpsMembers)
      .set({ lastName: null, email: null, mobile: null, emailKey: null, mobileKey: null, availability: null, area: null, coordinatorNotes: null, stopTokenHash: null, helpedCount: Math.max(m.helpedCount, dueStats.get(m.id)?.count12 ?? 0), lastHelpedOn: dueStats.get(m.id)?.last ?? m.lastHelpedOn, contactPurgedAt: now })
      .where(eq(corpsMembers.id, m.id));
  }
  const live = await db.select().from(corpsMembers).where(and(isNull(corpsMembers.contactPurgedAt), sql`${corpsMembers.status} not in ('left', 'pending')`));
  const stats = await helpStats(db, live, today);
  let refreshed = 0;
  for (const m of live) {
    const last = stats.get(m.id)?.last ?? null;
    if (last && last !== m.lastHelpedOn) {
      await db.update(corpsMembers).set({ lastHelpedOn: last }).where(eq(corpsMembers.id, m.id));
      refreshed++;
    }
  }
  return { unpaused: unpaused.length, purged: due.length, refreshed, pendingDeleted: dropped.length };
}
