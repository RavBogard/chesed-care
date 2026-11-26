/**
 * The morning summary: for each active person whose preference is not "none",
 * their day in counts (overdue follow-ups, due today, new Inbox items they may
 * review, newly assigned journey steps). Counts only, never a name or a word of a
 * note: it is stored as a daily_summaries row, shown as the "This morning" strip,
 * and sent by email or web push to those who chose it. Nothing is stored or sent on an
 * empty day. Each person's counts are worked out as that person, through the policy.
 */
import { and, count, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { canSetSummaryPref, decideAccess, deny, followUpVisibleWhere, proposalReviewWhere, summaryCountsInbox, type Actor, type Role } from "@/server/access/policy";
import { dailySummaries, followUps, proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { oneOf } from "@/server/care/validate";
import { chicagoToday } from "@/server/lifecycle/window";

export const SUMMARY_PREFS = ["email", "push", "both", "none"] as const;
export type SummaryPref = (typeof SUMMARY_PREFS)[number];
export type MorningSummary = { overdue: number; dueToday: number; inbox: number; newSteps: number };

/** No choice made: email for clergy and Mitzvah Corps leads, nothing for everyone else. */
export function defaultPref(role: Role): SummaryPref {
  return role === "owner" || role === "clergy" || role === "lead" ? "email" : "none";
}

export function effectivePref(user: { role: Role; summaryPref: SummaryPref | null }): SummaryPref {
  return user.summaryPref ?? defaultPref(user.role);
}

export function isEmptySummary(s: MorningSummary): boolean {
  return s.overdue + s.dueToday + s.inbox + s.newSteps === 0;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The words of the email or notification, when it is sent: counts and a link, and
 * nothing else. PURE. It is given counts only, so a name or a note cannot reach it.
 */
export function summaryMessage(s: MorningSummary, origin: string): { title: string; body: string; url: string } {
  const parts = [
    s.overdue ? plural(s.overdue, "overdue follow-up", "overdue follow-ups") : null,
    s.dueToday ? plural(s.dueToday, "follow-up due today", "follow-ups due today") : null,
    s.newSteps ? plural(s.newSteps, "new journey step for you", "new journey steps for you") : null,
    s.inbox ? plural(s.inbox, "new report in the Inbox", "new reports in the Inbox") : null,
  ].filter((p): p is string => p !== null);
  const url = `${origin}/`;
  return { title: "CRC Care this morning", body: `${parts.join(", ")}.\nOpen CRC Care: ${url}`, url };
}

export type ChannelResult = "sent" | "not_configured" | "not_chosen";
export type Delivery = { email: ChannelResult; push: ChannelResult };
/** A way out. Each receives only the person's id, the message built from counts (summaryMessage) and those counts. */
export type Channel = (userId: string, message: ReturnType<typeof summaryMessage>, summary: MorningSummary) => Promise<ChannelResult>;

/** The default when nothing is wired: both say so, and nothing is sent. Web push is wired by the daily job (src/server/notify/summary-channel.ts); email is wired by the daily job (src/server/email/summary-channel.ts). */
export const NOT_CONFIGURED: { email: Channel; push: Channel } = {
  email: async () => "not_configured",
  push: async () => "not_configured",
};

/** Hand a summary to the person's chosen channels. Nothing is sent on an empty day or to "none". */
export async function deliverSummary(user: { id: string; pref: SummaryPref }, summary: MorningSummary, origin: string, channels: { email: Channel; push: Channel } = NOT_CONFIGURED): Promise<Delivery> {
  const none: Delivery = { email: "not_chosen", push: "not_chosen" };
  if (user.pref === "none" || isEmptySummary(summary)) return none;
  const message = summaryMessage(summary, origin);
  const wantsEmail = user.pref === "email" || user.pref === "both";
  const wantsPush = user.pref === "push" || user.pref === "both";
  return {
    email: wantsEmail ? await channels.email(user.id, message, summary) : "not_chosen",
    push: wantsPush ? await channels.push(user.id, message, summary) : "not_chosen",
  };
}

/** One person's morning, as that person. `since`: what counts as new (the last day). */
export async function computeSummary(db: Db, actor: Actor, today: string, since: Date): Promise<MorningSummary> {
  const mine = and(followUpVisibleWhere(actor), eq(followUps.ownerUserId, actor.id), isNull(followUps.doneAt));
  const n = async (where: ReturnType<typeof and>) => (await db.select({ n: count() }).from(followUps).where(where))[0]?.n ?? 0;
  const [overdue, dueToday, newSteps] = await Promise.all([
    n(and(mine, lt(followUps.dueDate, today))),
    n(and(mine, eq(followUps.dueDate, today))),
    n(and(mine, isNotNull(followUps.journeyId), gte(followUps.createdAt, since))),
  ]);
  let inbox = 0;
  if (summaryCountsInbox(actor)) {
    const [row] = await db
      .select({ n: count() })
      .from(proposals)
      .where(and(eq(proposals.status, "pending"), proposalReviewWhere(actor), gte(proposals.createdAt, since)));
    inbox = row?.n ?? 0;
  }
  return { overdue, dueToday, inbox, newSteps };
}

/** The daily task: every active person with a preference other than "none". Counts only come back. */
export async function runMorningSummaries(db: Db, now: Date, owners: ReadonlySet<string>, origin: string | null, channels = NOT_CONFIGURED): Promise<Record<string, number>> {
  const today = chicagoToday(now);
  const since = new Date(now.getTime() - 86_400_000);
  const people = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active, summaryPref: users.summaryPref }).from(users).where(eq(users.active, true));
  const tally = { people: 0, stored: 0, emailNotConfigured: 0, pushNotConfigured: 0, sent: 0 };
  for (const p of people) {
    const access = decideAccess(p.email, owners, { id: p.id, role: p.role, active: p.active });
    if (access.kind === "denied") continue;
    const actor: Actor = { id: p.id, email: p.email, name: p.name, role: access.kind === "owner" ? "owner" : access.role };
    const pref = effectivePref({ role: actor.role, summaryPref: p.summaryPref });
    if (pref === "none") continue;
    tally.people++;
    const summary = await computeSummary(db, actor, today, since);
    if (isEmptySummary(summary)) continue;
    await db
      .insert(dailySummaries)
      .values({ userId: p.id, day: today, ...summary })
      .onConflictDoUpdate({ target: [dailySummaries.userId, dailySummaries.day], set: summary });
    tally.stored++;
    if (!origin) continue;
    const d = await deliverSummary({ id: p.id, pref }, summary, origin, channels);
    for (const r of [d.email, d.push]) if (r === "sent") tally.sent++;
    if (d.email === "not_configured") tally.emailNotConfigured++;
    if (d.push === "not_configured") tally.pushNotConfigured++;
  }
  return tally;
}

/** The actor's own summary for today, for the "This morning" strip; null on an empty day or before the job ran. */
export async function getMorningSummary(db: Db, actor: Actor, today: string): Promise<MorningSummary | null> {
  const [row] = await db
    .select({ overdue: dailySummaries.overdue, dueToday: dailySummaries.dueToday, inbox: dailySummaries.inbox, newSteps: dailySummaries.newSteps })
    .from(dailySummaries)
    .where(and(eq(dailySummaries.userId, actor.id), eq(dailySummaries.day, today)))
    .limit(1);
  return row && !isEmptySummary(row) ? row : null;
}

export async function getSummaryPref(db: Db, actor: Actor): Promise<{ pref: SummaryPref; chosen: boolean }> {
  if (!canSetSummaryPref(actor)) deny();
  const [row] = await db.select({ summaryPref: users.summaryPref }).from(users).where(eq(users.id, actor.id)).limit(1);
  const chosen = row?.summaryPref ?? null;
  return { pref: chosen ?? defaultPref(actor.role), chosen: chosen !== null };
}

export async function setSummaryPref(db: Db, actor: Actor, pref: unknown): Promise<SummaryPref> {
  if (!canSetSummaryPref(actor)) deny();
  const value = oneOf(pref, "summaryPref", SUMMARY_PREFS);
  await db.update(users).set({ summaryPref: value }).where(eq(users.id, actor.id));
  return value;
}
