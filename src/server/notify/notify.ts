/**
 * Who is notified, when, and what is held for quiet hours. The words are never chosen here: a call
 * names a kind (and a count), and src/lib/notice.ts holds the only sentences there are.
 *
 * Every audience is decided through src/server/access/policy.ts: a person is only ever notified about an
 * item they could open (proposalReviewWhere / canReviewProposal, careItemVisibleWhere, followUpVisibleWhere,
 * volunteerTaskVisibleWhere, mealPageVisibleWhere) and only for kinds their role and choices allow
 * (wantsNotice). The text is fixed and identical for every case, so a notice reveals nothing by itself.
 *
 * Nothing here logs a name, an id or a count: a fixed label and the error's class name at most.
 */
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { runAfterResponse } from "@/server/after";
import type { Notice, NoticeKind } from "@/lib/notice";
import { prefOf } from "@/lib/notice";
import { canCover, canSeePracticalRequests, careItemVisibleWhere, getsReferralNotice, decideAccess, followUpVisibleWhere, mealPageVisibleWhere, proposalReviewWhere, volunteerTaskVisibleWhere, wantsNotice, type Actor } from "@/server/access/policy";
import { isUuid } from "@/server/care/validate";
import { storedIntake } from "@/server/care/intake";
import { storedReading } from "@/server/care/reading";
import { careItems, corpsReferrals, followUps, mealPages, notificationHeld, notificationLog, proposals, pushSubscriptions, users, volunteerClaims, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { ownerEmails } from "@/server/env";
import { addDays, chicagoToday, HOUR_MS } from "@/server/lifecycle/window";
import { coverMap, listAwayToday, startingTomorrow } from "@/server/team/away";
import { pushStatus } from "./config";
import { chicagoHour, isQuiet, loadPrefs, type Prefs } from "./prefs";
import { sendPush } from "./send";

export type Owners = ReadonlySet<string>;
export const NEW_INBOX_GAP_MINUTES = 30;
export const VOLUNTEER_OPENED_DAYS = 3;
export const VOLUNTEER_ASKS_DAYS = 2;
/** A held notice older than this is dropped, not sent late. */
export const HELD_STALE_HOURS = 14;
/** The daily job runs about 6:00, the nearest it gets to the end of quiet hours: it may send when quiet ends within this many hours. */
export const JOB_LOOKAHEAD_HOURS = 2;
/** The urgent kind is capped per person, so no one (a flood of reports, a stranger on the public form) can make a phone buzz without end. */
export const URGENT_PER_HOUR = 3;
export const URGENT_PER_DAY = 8;
export const URGENT_PER_NIGHT = 2;
/** Past a cap, urgent items fold into one "N things need you today." notice, at most this often. */
export const DIGEST_GAP_MINUTES = 60;
/** Items passed to someone within this window are one notice, "N things were passed to you." */
export const ASSIGNED_WINDOW_MINUTES = 10;
const URGENT_KINDS: readonly string[] = ["urgent_inbox", "urgent_digest"];
const LOG_KEEP_DAYS = 30;

export type DeliverOutcome = "sent" | "folded" | "held" | "off" | "duplicate" | "batched" | "not_configured" | "no_devices" | "failed";
export type DeliverOptions = {
  now: Date;
  dedupeKey?: string;
  minGapMinutes?: number;
  /** The daily job: quiet counts only if it lasts past the job's hours. */
  fromJob?: boolean;
  /** Sending what was held: the hold check was already made. */
  skipQuiet?: boolean;
};

type UserRow = { id: string; email: string; name: string | null; role: Actor["role"]; active: boolean };

function actorOf(row: UserRow, owners: Owners): Actor | null {
  const access = decideAccess(row.email, owners, { id: row.id, role: row.role, active: row.active });
  return access.kind === "denied" ? null : { id: row.id, email: row.email, name: row.name, role: access.kind === "owner" ? "owner" : access.role };
}

const userColumnsForActor = { id: users.id, email: users.email, name: users.name, role: users.role, active: users.active };

/** Every active, allowed person, as an actor. */
export async function loadRecipients(db: Db, owners: Owners): Promise<Actor[]> {
  const rows = await db.select(userColumnsForActor).from(users).where(eq(users.active, true));
  return rows.flatMap((r) => actorOf(r, owners) ?? []);
}

async function loadActor(db: Db, userId: string, owners: Owners): Promise<Actor | null> {
  const [row] = await db.select(userColumnsForActor).from(users).where(eq(users.id, userId)).limit(1);
  return row ? actorOf(row, owners) : null;
}

function quietNow(prefs: Prefs, now: Date, fromJob: boolean): boolean {
  if (!fromJob) return isQuiet(prefs, now);
  return isQuiet(prefs, now) && isQuiet(prefs, new Date(now.getTime() + JOB_LOOKAHEAD_HOURS * 3_600_000));
}

/**
 * Decide and send one notice to one person: their switch for the kind, their quiet hours (held, except the
 * urgent kind unless they turned that off), once per key, and at most one per gap. Sends through sendPush.
 */
export async function deliverNotice(db: Db, actor: Actor, notice: Notice, opts: DeliverOptions): Promise<DeliverOutcome> {
  if (!pushStatus().configured) return "not_configured";
  const prefs = await loadPrefs(db, actor.id);
  const group = prefOf(notice.kind);
  if (group && !wantsNotice(actor, group, prefs.kinds)) return "off";
  const [{ devices }] = await db
    .select({ devices: count() })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, actor.id), isNull(pushSubscriptions.revokedAt)));
  if (devices === 0) return "no_devices";
  // Quiet hours have ended: what was held goes first, so a window that ends after the daily job is not lost.
  if (!opts.skipQuiet && !isQuiet(prefs, opts.now)) await flushHeldFor(db, actor, opts.now, prefs);
  const urgentThrough = notice.kind === "urgent_inbox" && prefs.urgentIgnoresQuiet;
  if (!opts.skipQuiet && !urgentThrough && quietNow(prefs, opts.now, opts.fromJob === true)) {
    const heldCount = "count" in notice ? notice.count : null;
    await db
      .insert(notificationHeld)
      .values({ userId: actor.id, kind: notice.kind, count: heldCount, createdAt: opts.now })
      .onConflictDoUpdate({ target: [notificationHeld.userId, notificationHeld.kind], set: { count: heldCount, createdAt: opts.now } });
    return "held";
  }
  if (opts.minGapMinutes) {
    const since = new Date(opts.now.getTime() - opts.minGapMinutes * 60_000);
    const [recent] = await db
      .select({ id: notificationLog.id })
      .from(notificationLog)
      .where(and(eq(notificationLog.userId, actor.id), eq(notificationLog.kind, notice.kind), gt(notificationLog.createdAt, since)))
      .limit(1);
    if (recent) return "batched";
  }
  const [claim] = await db
    .insert(notificationLog)
    .values({ userId: actor.id, kind: notice.kind, dedupeKey: opts.dedupeKey ?? null, createdAt: opts.now })
    .onConflictDoNothing()
    .returning({ id: notificationLog.id });
  if (!claim) return "duplicate";
  const result = await sendPush(db, actor.id, notice, opts.now);
  if (result.status === "done" && result.sent > 0) return "sent";
  // Nothing got through: free the claim so a later attempt is not blocked by this one.
  await db.delete(notificationLog).where(eq(notificationLog.id, claim.id));
  return "failed";
}

// ─── the Inbox ───────────────────────────────────────────────────────────────────────

function isUrgentReading(reading: unknown): boolean {
  const urgency = storedReading(reading)?.urgency;
  return urgency === "today" || urgency === "now";
}

/** Hold one urgent notice for the end of quiet hours (one row; it is sent then as "Something needed you overnight."). */
async function holdUrgent(db: Db, userId: string, now: Date): Promise<DeliverOutcome> {
  await db.insert(notificationHeld).values({ userId, kind: "urgent_inbox", count: null, createdAt: now }).onConflictDoNothing();
  return "held";
}

/** When the current quiet window began (America/Chicago), for "at most 2 a night". Only meaningful while quiet. */
function quietWindowStart(prefs: Prefs, now: Date): Date {
  const elapsedHours = (chicagoHour(now) - prefs.quietStartHour + 24) % 24;
  const intoHour = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - elapsedHours * HOUR_MS - intoHour);
}

async function loggedSince(db: Db, userId: string, kinds: readonly string[], since: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(notificationLog).where(and(eq(notificationLog.userId, userId), inArray(notificationLog.kind, [...kinds]), gte(notificationLog.createdAt, since)));
  return row.n;
}

/** Past a cap: one more urgent item is folded into the held "N things need you today." count, sent at most once an hour (and never in quiet hours). */
async function foldUrgent(db: Db, actor: Actor, now: Date, quiet: boolean): Promise<DeliverOutcome> {
  await db
    .insert(notificationHeld)
    .values({ userId: actor.id, kind: "urgent_digest", count: 1, createdAt: now })
    .onConflictDoUpdate({ target: [notificationHeld.userId, notificationHeld.kind], set: { count: sql`coalesce(${notificationHeld.count}, 0) + 1`, createdAt: now } });
  if (!quiet && (await loggedSince(db, actor.id, ["urgent_digest"], new Date(now.getTime() - DIGEST_GAP_MINUTES * 60_000))) === 0) {
    const [held] = await db.select({ n: notificationHeld.count }).from(notificationHeld).where(and(eq(notificationHeld.userId, actor.id), eq(notificationHeld.kind, "urgent_digest"))).limit(1);
    if (held) {
      const out = await deliverNotice(db, actor, { kind: "urgent_digest", count: held.n ?? 1 }, { now, skipQuiet: true });
      if (out === "sent") await db.delete(notificationHeld).where(and(eq(notificationHeld.userId, actor.id), eq(notificationHeld.kind, "urgent_digest")));
    }
  }
  return "folded";
}

/**
 * One urgent proposal for one person who may review it. Once per proposal per person; at most 3 an hour and 8 a day (past
 * that, folded into one digest); in quiet hours at most 2 a night, the rest held to the end of quiet hours. A public-form
 * report (unverified words from a stranger) never reaches a phone in quiet hours on the AI's reading alone: it is held.
 */
export async function deliverUrgent(db: Db, actor: Actor, o: { now: Date; proposalId: string; publicForm: boolean }): Promise<DeliverOutcome> {
  if (!pushStatus().configured) return "not_configured";
  const { now } = o;
  const prefs = await loadPrefs(db, actor.id);
  if (!wantsNotice(actor, "urgent_inbox", prefs.kinds)) return "off";
  const [{ devices }] = await db
    .select({ devices: count() })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, actor.id), isNull(pushSubscriptions.revokedAt)));
  if (devices === 0) return "no_devices";
  const [seen] = await db
    .insert(notificationLog)
    .values({ userId: actor.id, kind: "urgent_seen", dedupeKey: o.proposalId, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: notificationLog.id });
  if (!seen) return "duplicate";
  const quiet = isQuiet(prefs, now);
  if (!quiet) await flushHeldFor(db, actor, now, prefs);
  if (quiet && (o.publicForm || !prefs.urgentIgnoresQuiet)) return holdUrgent(db, actor.id, now);
  if ((await loggedSince(db, actor.id, ["urgent_inbox"], new Date(now.getTime() - HOUR_MS))) >= URGENT_PER_HOUR || (await loggedSince(db, actor.id, ["urgent_inbox"], new Date(now.getTime() - 24 * HOUR_MS))) >= URGENT_PER_DAY) {
    return foldUrgent(db, actor, now, quiet);
  }
  if (quiet && (await loggedSince(db, actor.id, URGENT_KINDS, quietWindowStart(prefs, now))) >= URGENT_PER_NIGHT) return holdUrgent(db, actor.id, now);
  return deliverNotice(db, actor, { kind: "urgent_inbox" }, { now, skipQuiet: true });
}

/**
 * "Something needs you today.": a pending proposal whose reading says today, or a Salesforce death. Sent to each
 * person who may review THAT proposal, at most once per proposal per person, inside the caps of deliverUrgent. Call
 * when the reading lands (or on creation, for Salesforce).
 */
export async function noticeUrgentProposal(db: Db, proposalId: string, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<number> {
  if (!pushStatus().configured) return 0;
  const [row] = await db
    .select({ id: proposals.id, status: proposals.status, reading: proposals.reading, channel: proposals.channel, intake: proposals.intake })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!row || row.status !== "pending") return 0;
  const intake = storedIntake(row.intake);
  const death = row.channel === "salesforce" && intake?.kind === "salesforce" && intake.event === "death";
  if (!death && !isUrgentReading(row.reading)) return 0;
  let sent = 0;
  const everyone = await loadRecipients(db, owners);
  // Asked of the database, so a proposal scoped to a restricted care item reaches only those the item is open to.
  const mayReview = async (actor: Actor) => (await db.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.id, row.id), proposalReviewWhere(actor))).limit(1)).length > 0;
  const reviewers: Actor[] = [];
  for (const actor of everyone) if (await mayReview(actor)) reviewers.push(actor);
  const awayNow = await listAwayToday(db, chicagoToday(now));
  const cover = coverMap(awayNow);
  const awayIds = new Set(awayNow.map((a) => a.userId));
  // Someone away is not told while away; their coverer is (if they may review this one). deliverUrgent still honours an explicit "off".
  const covers: Actor[] = [];
  for (const a of reviewers.filter((r) => cover.has(r.id))) {
    const c = everyone.find((e) => e.id === cover.get(a.id));
    if (c && (await mayReview(c))) covers.push(c);
  }
  const told = [...reviewers.filter((a) => !awayIds.has(a.id)), ...covers].filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i);
  for (const actor of told) {
    if ((await deliverUrgent(db, actor, { now, proposalId, publicForm: row.channel === "form" })) === "sent") sent++;
  }
  return sent;
}

/** The same, for a Salesforce arrival known only by its external key (the daily job makes these). */
export async function noticeUrgentByKey(db: Db, externalKey: string, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<number> {
  if (!pushStatus().configured) return 0;
  const [row] = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.externalKey, externalKey)).limit(1);
  return row ? noticeUrgentProposal(db, row.id, now, owners) : 0;
}

/**
 * "N new in your Inbox.": for each person who switched it on, the pending proposals they may review that arrived
 * since their last such notice (their own captures do not count), at most one notice per 30 minutes.
 */
export async function noticeNewInbox(db: Db, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<number> {
  if (!pushStatus().configured) return 0;
  let sent = 0;
  for (const actor of await loadRecipients(db, owners)) {
    const prefs = await loadPrefs(db, actor.id);
    if (!wantsNotice(actor, "new_inbox", prefs.kinds)) continue;
    const [last] = await db
      .select({ at: notificationLog.createdAt })
      .from(notificationLog)
      .where(and(eq(notificationLog.userId, actor.id), eq(notificationLog.kind, "new_inbox")))
      .orderBy(desc(notificationLog.createdAt))
      .limit(1);
    if (last && now.getTime() - last.at.getTime() < NEW_INBOX_GAP_MINUTES * 60_000) continue;
    const since = last?.at ?? new Date(now.getTime() - 86_400_000);
    const [{ n }] = await db
      .select({ n: count() })
      .from(proposals)
      .where(and(eq(proposals.status, "pending"), proposalReviewWhere(actor), gt(proposals.createdAt, since), or(isNull(proposals.submittedBy), ne(proposals.submittedBy, actor.id))));
    if (n === 0) continue;
    if ((await deliverNotice(db, actor, { kind: "new_inbox", count: n }, { now, minGapMinutes: NEW_INBOX_GAP_MINUTES })) === "sent") sent++;
  }
  return sent;
}

// ─── passed to you ───────────────────────────────────────────────────────────────────

/** Who holds a follow-up now, so a save that does not change the holder sends nothing. Null when there is none (or the id is not one). */
export async function followUpOwner(db: Db, id: string | undefined): Promise<string | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select({ owner: followUps.ownerUserId }).from(followUps).where(eq(followUps.id, id)).limit(1);
  return row?.owner ?? null;
}

export type Assigned = { toUserId: string; byUserId: string; careItemId?: string; followUpId?: string };
export type AssignedMany = { toUserId: string; byUserId: string; careItemIds: string[]; followUpIds: string[] };

/** What of this the person can open, by the same rules as the screens. */
async function openableItems(db: Db, actor: Actor, careItemIds: readonly string[], followUpIds: readonly string[]): Promise<number> {
  let n = 0;
  if (careItemIds.length > 0) n += (await db.select({ n: count() }).from(careItems).where(and(inArray(careItems.id, [...careItemIds]), careItemVisibleWhere(actor))))[0].n;
  if (followUpIds.length > 0) n += (await db.select({ n: count() }).from(followUps).where(and(inArray(followUps.id, [...followUpIds]), followUpVisibleWhere(actor))))[0].n;
  return n;
}

/**
 * "Something was passed to you.": a care item or follow-up given to the person by someone else. Only when the
 * person can open it: a restricted item they are shut out of, or a caregiver's item that is not visible to them,
 * sends nothing. Once per item; when more than one arrives within 10 minutes the notice becomes "N things were
 * passed to you." (at most one such update a minute; it replaces the earlier one on the phone).
 */
export async function noticeAssigned(db: Db, what: Assigned, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<boolean> {
  if (!pushStatus().configured || what.toUserId === what.byUserId) return false;
  const ref = what.careItemId ?? what.followUpId;
  if (!ref) return false;
  const actor = await loadActor(db, what.toUserId, owners);
  if (!actor) return false;
  if ((await openableItems(db, actor, what.careItemId ? [what.careItemId] : [], what.followUpId ? [what.followUpId] : [])) === 0) return false;
  const bucket = Math.floor(now.getTime() / (ASSIGNED_WINDOW_MINUTES * 60_000));
  const [claim] = await db
    .insert(notificationLog)
    .values({ userId: actor.id, kind: "assigned_item", dedupeKey: `${ref}:${bucket}`, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: notificationLog.id });
  if (!claim) return false;
  const since = new Date(now.getTime() - ASSIGNED_WINDOW_MINUTES * 60_000);
  const n = await loggedSince(db, actor.id, ["assigned_item"], since);
  if (n <= 1) return (await deliverNotice(db, actor, { kind: "assigned" }, { now })) === "sent";
  return (await deliverNotice(db, actor, { kind: "assigned_many", count: n }, { now, minGapMinutes: 1 })) === "sent";
}

/** Several things given to one person at once (a hand-over): one notice, counting only what they can open. */
export async function noticeAssignedMany(db: Db, what: AssignedMany, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<boolean> {
  if (!pushStatus().configured || what.toUserId === what.byUserId) return false;
  const actor = await loadActor(db, what.toUserId, owners);
  if (!actor) return false;
  const n = await openableItems(db, actor, what.careItemIds, what.followUpIds);
  if (n === 0) return false;
  const notice: Notice = n === 1 ? { kind: "assigned" } : { kind: "assigned_many", count: n };
  return (await deliverNotice(db, actor, notice, { now })) === "sent";
}

// ─── volunteers and meals ────────────────────────────────────────────────────────────

/** Coordinators who switched the kind on and for whom `visible` finds something, with how many. */
async function coordinatorsWhere(db: Db, owners: Owners, visible: (actor: Actor) => Promise<number>): Promise<{ actor: Actor; n: number }[]> {
  const out: { actor: Actor; n: number }[] = [];
  for (const actor of await loadRecipients(db, owners)) {
    const prefs = await loadPrefs(db, actor.id);
    if (!wantsNotice(actor, "coordinator", prefs.kinds)) continue;
    const n = await visible(actor);
    if (n > 0) out.push({ actor, n });
  }
  return out;
}

export type PlaceGivenBack = { taskIds: readonly string[] } | { mealPageId: string; slotDate: string };

/**
 * "A volunteer place opened up.": a volunteer gave a place back, or a helper cancelled a meal night, and the date is
 * within 3 days (and not past). Sent to the coordinators who can open that task or meal page.
 */
export async function noticePlaceOpened(db: Db, what: PlaceGivenBack, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<number> {
  if (!pushStatus().configured) return 0;
  const today = chicagoToday(now);
  const last = addDays(today, VOLUNTEER_OPENED_DAYS);
  let visible: (actor: Actor) => Promise<number>;
  if ("taskIds" in what) {
    if (what.taskIds.length === 0) return 0;
    const ids = [...what.taskIds];
    visible = async (actor) => {
      const [row] = await db
        .select({ n: count() })
        .from(volunteerTasks)
        .where(and(inArray(volunteerTasks.id, ids), sql`${volunteerTasks.taskDate} >= ${today}`, sql`${volunteerTasks.taskDate} <= ${last}`, volunteerTaskVisibleWhere(actor)));
      return row.n;
    };
  } else {
    if (what.slotDate < today || what.slotDate > last) return 0;
    const pageId = what.mealPageId;
    visible = async (actor) => {
      const [row] = await db.select({ n: count() }).from(mealPages).where(and(eq(mealPages.id, pageId), mealPageVisibleWhere(actor)));
      return row.n;
    };
  }
  let sent = 0;
  for (const { actor } of await coordinatorsWhere(db, owners, visible)) if ((await deliverNotice(db, actor, { kind: "volunteer_opened" }, { now })) === "sent") sent++;
  return sent;
}

/**
 * "N asks still need someone.": daily, for each coordinator, the open volunteer tasks they can open that are within
 * 2 days and still have places left. Once per person per day.
 */
export async function noticeUnfilledAsks(db: Db, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<{ people: number; sent: number }> {
  if (!pushStatus().configured) return { people: 0, sent: 0 };
  const today = chicagoToday(now);
  const last = addDays(today, VOLUNTEER_ASKS_DAYS);
  const taken = db
    .select({ n: count() })
    .from(volunteerClaims)
    .where(and(eq(volunteerClaims.taskId, volunteerTasks.id), isNull(volunteerClaims.cancelledAt)));
  const unfilled: SQL = sql`(${taken}) < ${volunteerTasks.peopleNeeded}`;
  const found = await coordinatorsWhere(db, owners, async (actor) => {
    const [row] = await db
      .select({ n: count() })
      .from(volunteerTasks)
      .where(and(eq(volunteerTasks.status, "open"), isNull(volunteerTasks.cancelledAt), isNull(volunteerTasks.doneAt), sql`${volunteerTasks.taskDate} >= ${today}`, sql`${volunteerTasks.taskDate} <= ${last}`, unfilled, volunteerTaskVisibleWhere(actor)));
    return row.n;
  });
  let sent = 0;
  for (const { actor, n } of found) if ((await deliverNotice(db, actor, { kind: "volunteer_asks", count: n }, { now, dedupeKey: today, fromJob: true })) === "sent") sent++;
  return { people: found.length, sent };
}

/**
 * "Someone asked Mitzvah Corps for help.": a public-form practical request the lead may see. Fixed words, nothing of the
 * report. Sent to each person who can see practical requests and has the coordinator switch on (the lead by default,
 * owner and clergy only if they turned it on). Quiet hours hold it like any other non-urgent notice, so a stranger's
 * form never buzzes a phone at night; at most one every 30 minutes (the new-Inbox cap), once per request per person.
 */
export async function noticePracticalRequest(db: Db, proposalId: string, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<number> {
  if (!pushStatus().configured) return 0;
  const [row] = await db.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.status, "pending"), eq(proposals.practical, true), eq(proposals.leadVisible, true), eq(proposals.channel, "form"))).limit(1);
  if (!row) return 0;
  let sent = 0;
  for (const actor of await loadRecipients(db, owners)) {
    if (!canSeePracticalRequests(actor)) continue;
    if ((await deliverNotice(db, actor, { kind: "practical_request" }, { now, dedupeKey: `practical:${proposalId}`, minGapMinutes: NEW_INBOX_GAP_MINUTES })) === "sent") sent++;
  }
  return sent;
}

/**
 * A rabbi referred someone to Mitzvah Corps: the same fixed words as a practical request ("Someone asked Mitzvah Corps
 * for help."), nothing of the referral. Sent to the active leads who have the coordinator switch on (theirs by default).
 * Not while a rabbi is still asking the person: it goes once the referral may be acted on. Once per referral per person,
 * held by quiet hours, at most one every 30 minutes.
 */
export async function noticeReferral(db: Db, referralId: string, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<number> {
  if (!pushStatus().configured) return 0;
  const [row] = await db.select({ id: corpsReferrals.id }).from(corpsReferrals).where(and(eq(corpsReferrals.id, referralId), isNull(corpsReferrals.closedAt), ne(corpsReferrals.consent, "rabbi_asks"))).limit(1);
  if (!row) return 0;
  let sent = 0;
  for (const actor of await loadRecipients(db, owners)) {
    if (!getsReferralNotice(actor)) continue;
    if ((await deliverNotice(db, actor, { kind: "practical_request" }, { now, dedupeKey: `referral:${referralId}`, minGapMinutes: NEW_INBOX_GAP_MINUTES })) === "sent") sent++;
  }
  return sent;
}

// ─── held notices and the daily job's housekeeping ───────────────────────────────────

/** Most important first: when several were held, the person gets one notice, for the first of these. */
const HELD_ORDER: readonly NoticeKind[] = ["urgent_inbox", "urgent_digest", "assigned", "covering_tomorrow", "volunteer_opened", "volunteer_asks", "practical_request", "new_inbox", "morning_summary"];

function heldNotice(kind: NoticeKind, heldCount: number | null): Notice {
  if (kind === "urgent_inbox") return { kind: "urgent_overnight" };
  if (kind === "new_inbox" || kind === "morning_summary" || kind === "volunteer_asks" || kind === "urgent_digest") return { kind, count: heldCount ?? 0 };
  return { kind: kind as "assigned" | "volunteer_opened" | "covering_tomorrow" | "practical_request" };
}

/** Send one person's held notices as ONE notice, the most important first, and forget them all. A held urgent one is never dropped as stale. */
async function flushUser(db: Db, actor: Actor, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - HELD_STALE_HOURS * 3_600_000);
  await db.delete(notificationHeld).where(and(eq(notificationHeld.userId, actor.id), lt(notificationHeld.createdAt, cutoff), sql`${notificationHeld.kind} not in ('urgent_inbox', 'urgent_digest')`));
  let held = await db.select().from(notificationHeld).where(eq(notificationHeld.userId, actor.id));
  // The digest keeps its own limit: not twice within an hour, however it is reached.
  if ((await loggedSince(db, actor.id, ["urgent_digest"], new Date(now.getTime() - DIGEST_GAP_MINUTES * 60_000))) > 0) held = held.filter((h) => h.kind !== "urgent_digest");
  if (held.length === 0) return false;
  await db.delete(notificationHeld).where(inArray(notificationHeld.id, held.map((h) => h.id)));
  const top = HELD_ORDER.map((k) => held.find((h) => h.kind === k)).find((h) => h !== undefined);
  if (!top) return false;
  return (await deliverNotice(db, actor, heldNotice(top.kind as NoticeKind, top.count), { now, skipQuiet: true })) === "sent";
}

/** On the next notice for a person whose quiet hours have ended: send what was held for them. */
async function flushHeldFor(db: Db, actor: Actor, now: Date, prefs: Prefs): Promise<void> {
  if (isQuiet(prefs, now)) return;
  const [any] = await db.select({ id: notificationHeld.id }).from(notificationHeld).where(eq(notificationHeld.userId, actor.id)).limit(1);
  if (any) await flushUser(db, actor, now);
}

/**
 * The daily job: send what was held overnight as ONE notice per person once quiet hours have ended (or end within
 * the job's 2 hours), drop non-urgent notices that went stale. Held urgent ones are always sent.
 */
export async function flushHeld(db: Db, now: Date, owners: Owners = ownerEmails()): Promise<{ stale: number; sent: number; waiting: number }> {
  const out = { stale: 0, sent: 0, waiting: 0 };
  const cutoff = new Date(now.getTime() - HELD_STALE_HOURS * 3_600_000);
  out.stale = (await db.delete(notificationHeld).where(and(lt(notificationHeld.createdAt, cutoff), sql`${notificationHeld.kind} not in ('urgent_inbox', 'urgent_digest')`)).returning({ id: notificationHeld.id })).length;
  const people = [...new Set((await db.select({ userId: notificationHeld.userId }).from(notificationHeld)).map((r) => r.userId))];
  for (const userId of people) {
    const actor = await loadActor(db, userId, owners);
    if (!actor) {
      await db.delete(notificationHeld).where(eq(notificationHeld.userId, userId));
      continue;
    }
    if (quietNow(await loadPrefs(db, userId), now, true)) {
      out.waiting++;
      continue;
    }
    if (await flushUser(db, actor, now)) out.sent++;
  }
  return out;
}

/** Forget what was sent after 30 days (it only existed to stop repeats). */
export async function purgeNotificationLog(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - LOG_KEEP_DAYS * 86_400_000);
  return (await db.delete(notificationLog).where(lt(notificationLog.createdAt, cutoff)).returning({ id: notificationLog.id })).length;
}

// ─── after the response ──────────────────────────────────────────────────────────────

/**
 * Run a notice after the response is sent, so a user's action never waits on a push service. Never throws; a
 * failure logs a fixed label and the error's class.
 */
export function afterResponse(task: () => Promise<unknown>): void {
  if (!pushStatus().configured) return;
  runAfterResponse("push.notice_failed", task);
}

// ─── covering for a colleague ────────────────────────────────────────────────────────

/**
 * "You are covering for a colleague from tomorrow.": once per window, to the colleague named to cover someone whose
 * "away" begins tomorrow. Fixed text: no name. Called by the daily job, and when the window is set for tomorrow.
 */
export async function noticeCoveringTomorrow(db: Db, now: Date = new Date(), owners: Owners = ownerEmails()): Promise<number> {
  if (!pushStatus().configured) return 0;
  let sent = 0;
  for (const w of await startingTomorrow(db, now)) {
    const actor = await loadActor(db, w.coverUserId, owners);
    if (!actor || !canCover({ role: actor.role, active: true })) continue;
    if ((await deliverNotice(db, actor, { kind: "covering_tomorrow" }, { now, dedupeKey: `cover:${w.userId}:${w.from}`, fromJob: true })) === "sent") sent++;
  }
  return sent;
}
