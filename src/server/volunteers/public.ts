/**
 * The public side of volunteer tasks. NO ACTOR: whoever holds a link calls these, and a
 * link will be posted to a group text, so every argument is hostile until it has passed
 * ./input.ts.
 *
 * By task, board or sheet token: what the page shows (an allow-list built field by field
 * below: never the place, the contact line, the poster, a care item, or anyone's name but
 * a first name on a shiva sheet's "bringing" list), and claiming. The place and the
 * contact line are given only in answer to a successful claim, and afterwards to that
 * volunteer's personal token (stored only as its hash).
 *
 * A token that matches nothing, a cancelled task and one whose date has gone by (plus a
 * day) all answer "not found" and nothing else, so a stranger cannot tell them apart.
 * Every claim and every cancellation is an audit row (ids only) written in the same
 * transaction as the change.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { writeLinkAudit } from "@/server/care/audit";
import { isUuid } from "@/server/care/validate";
import { careItems, users, volunteerBoards, volunteerBringing, volunteerClaims, volunteerGroups, volunteerTaskBlocks, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { addToLimit, atLimit, countOf, readClient, withinLimit } from "@/server/meals/rate-limit";
import { newToken, tokenHash } from "@/server/meals/tokens";
import { activeCounts, CONGREGATION, detailsOf, isLive, isPast, lastViewDay, placesLeft, type Claim, type ClaimDetails, type Task } from "./core";
import { afterResponse, noticePlaceOpened } from "@/server/notify/notify";
import { volunteerIcs } from "./ics";
import { badFields, bringingInput, claimInput, doneInput, normalizeContact, type Kind } from "./input";

/** Attempts per clock hour. */
export const VOLUNTEER_LIMITS = {
  /** Claim attempts from one client; every attempt counts. */
  claimPerClient: 20,
  /** Claims that SUCCEED on one task, from everyone. Failed attempts never count, so junk cannot lock a task. */
  claimPerTask: 30,
  /** Cancellations and "done" taps through personal links, from one client. */
  managePerClient: 30,
  /** Claims that SUCCEED on one task from one client: one address cannot fill a minyan (several real people may share a house's wifi). */
  claimOkPerClientPerTask: 4,
  /** Claims that SUCCEED from one client across every task. */
  claimOkPerClient: 8,
  /** Dates one client may take per hour across every claim: a single claim is 1, an "every time" claim is the number of dates it takes. */
  claimDatesPerClient: 26,
  /** "Bringing" attempts from one client. */
  bringPerClient: 10,
  /** "Bringing" lines that SUCCEED from one client on one sheet. */
  bringOkPerClientPerSheet: 3,
} as const;
/** Most "bringing" lines a shiva sheet holds. */
export const MAX_BRINGING = 40;

export type Refusal = "not_found" | "full" | "past" | "closed" | "refused" | "rate_limited" | "invalid";
export type Refused = { ok: false; reason: Refusal; fields?: string[] };
const refused = (reason: Refusal, fields?: string[]): Refused => ({ ok: false, reason, ...(fields ? { fields } : {}) });

// ─── what a link shows ────────────────────────────────────────────────────────────────

export type PublicTask = { congregation: string; kind: Kind; forLabel: string; needed: string; date: string; timeWindow: string | null; peopleNeeded: number; taken: number; placesLeft: number; past: boolean; /** On a repeating task: how many dates in the series are still open ahead. Otherwise 0. */ everyTimeDates: number };

async function liveTaskByToken(db: Db, token: unknown, today: string): Promise<Task | null> {
  const [task] = await db.select().from(volunteerTasks).where(eq(volunteerTasks.publicTokenHash, tokenHash(token))).limit(1);
  return task && isLive(task, today) ? task : null;
}

/** What anyone with the link sees, field by field. Null: no such task, or one that is cancelled, done or expired. */
export async function getPublicTask(db: Db, token: unknown, now: Date = new Date()): Promise<PublicTask | null> {
  const today = chicagoToday(now);
  const task = await liveTaskByToken(db, token, today);
  if (!task) return null;
  const taken = (await activeCounts(db, [task.id])).get(task.id) ?? 0;
  const [ahead] = task.seriesId ? await db.select({ n: count() }).from(volunteerTasks).where(and(eq(volunteerTasks.seriesId, task.seriesId), eq(volunteerTasks.status, "open"), gte(volunteerTasks.taskDate, today))) : [{ n: 0 }];
  return {
    congregation: CONGREGATION,
    kind: task.kind,
    forLabel: task.forLabel,
    needed: task.needed,
    date: task.taskDate,
    timeWindow: task.timeWindow,
    peopleNeeded: task.peopleNeeded,
    taken,
    placesLeft: placesLeft(task, taken),
    past: isPast(task, today),
    everyTimeDates: ahead.n,
  };
}

export type BoardItem = { kind: Kind; forLabel: string; date: string; timeWindow: string | null; placesLeft: number; href: string };
export type PublicBoard = { congregation: string; items: BoardItem[] };

/**
 * One poster's open tasks that still have a place and are not past. Never one linked to a restricted
 * care item. Null: no such board, or its owner is no longer active.
 */
export async function getPublicBoard(db: Db, token: unknown, now: Date = new Date()): Promise<PublicBoard | null> {
  const today = chicagoToday(now);
  const [board] = await db
    .select({ ownerUserId: volunteerBoards.ownerUserId })
    .from(volunteerBoards)
    .innerJoin(users, and(eq(users.id, volunteerBoards.ownerUserId), eq(users.active, true)))
    .where(eq(volunteerBoards.tokenHash, tokenHash(token)))
    .limit(1);
  if (!board) return null;
  const rows = await db
    .select({ task: volunteerTasks, groupToken: volunteerGroups.publicToken, groupCancelled: volunteerGroups.cancelledAt })
    .from(volunteerTasks)
    .leftJoin(careItems, eq(careItems.id, volunteerTasks.careItemId))
    .leftJoin(volunteerGroups, eq(volunteerGroups.id, volunteerTasks.groupId))
    .where(and(eq(volunteerTasks.createdBy, board.ownerUserId), eq(volunteerTasks.status, "open"), gte(volunteerTasks.taskDate, today), or(isNull(volunteerTasks.careItemId), eq(careItems.restricted, false))))
    .orderBy(asc(volunteerTasks.taskDate), asc(volunteerTasks.createdAt));
  const counts = await activeCounts(db, rows.map((r) => r.task.id));
  const items: BoardItem[] = [];
  for (const { task, groupToken, groupCancelled } of rows) {
    const left = placesLeft(task, counts.get(task.id) ?? 0);
    const link = task.groupId ? (groupCancelled ? null : groupToken) : task.publicToken;
    if (left === 0 || !link) continue;
    items.push({ kind: task.kind, forLabel: task.forLabel, date: task.taskDate, timeWindow: task.timeWindow, placesLeft: left, href: task.groupId ? `/v/s/${link}` : `/v/${link}` });
  }
  return { congregation: CONGREGATION, items };
}

export type SheetEvening = { taskId: string; date: string; timeWindow: string | null; peopleNeeded: number; taken: number; placesLeft: number; past: boolean };
export type PublicSheet = { congregation: string; title: string; needed: string; evenings: SheetEvening[]; bringing: { firstName: string; line: string }[]; bringingFull: boolean };

async function liveGroupByToken(db: Db, token: unknown) {
  const [group] = await db
    .select()
    .from(volunteerGroups)
    .where(and(eq(volunteerGroups.publicTokenHash, tokenHash(token)), isNull(volunteerGroups.cancelledAt)))
    .limit(1);
  return group ?? null;
}

/** A shiva sheet: the evenings with their count toward ten, and who is bringing what. Null: no such sheet, or no evening left that is open. */
export async function getPublicSheet(db: Db, token: unknown, now: Date = new Date()): Promise<PublicSheet | null> {
  const today = chicagoToday(now);
  const group = await liveGroupByToken(db, token);
  if (!group) return null;
  const tasks = (await db.select().from(volunteerTasks).where(eq(volunteerTasks.groupId, group.id)).orderBy(asc(volunteerTasks.taskDate), asc(volunteerTasks.createdAt))).filter((t) => isLive(t, today));
  if (tasks.length === 0) return null;
  const counts = await activeCounts(db, tasks.map((t) => t.id));
  const bringing = await db.select({ firstName: volunteerBringing.firstName, line: volunteerBringing.line }).from(volunteerBringing).where(eq(volunteerBringing.groupId, group.id)).orderBy(asc(volunteerBringing.createdAt));
  return {
    congregation: CONGREGATION,
    title: group.title,
    needed: tasks[0].needed,
    evenings: tasks.map((t) => {
      const taken = counts.get(t.id) ?? 0;
      return { taskId: t.id, date: t.taskDate, timeWindow: t.timeWindow, peopleNeeded: t.peopleNeeded, taken, placesLeft: placesLeft(t, taken), past: isPast(t, today) };
    }),
    bringing,
    bringingFull: bringing.length >= MAX_BRINGING,
  };
}

// ─── claiming ─────────────────────────────────────────────────────────────────────────

/** Thrown inside a transaction to roll it back. */
class NoPlace extends Error {
  constructor(readonly reason: "full" | "closed" | "rate") {
    super(reason);
  }
}

export type ClaimOptions = { personRef?: string | null };
const personRefOf = (opts: ClaimOptions): string | null => (isUuid(opts.personRef) ? opts.personRef : null);

export type ClaimResult = { ok: true; claimId: string; manageToken: string; details: ClaimDetails } | Refused;

/**
 * The one claim path. `task` was found through a token the caller holds. The per-task cap
 * is charged only after a claim succeeds. The place count is re-read under a row lock, so
 * two people cannot take the last place.
 */
async function claim(db: Db, task: Task, input: unknown, clientMeta: unknown, now: Date, personRef: string | null): Promise<ClaimResult> {
  const client = readClient(clientMeta, now, true);
  if (!client) return refused("invalid", ["clientMeta"]);
  if (!(await withinLimit(db, `vol:claim:client:${client.hash}`, VOLUNTEER_LIMITS.claimPerClient, now))) return refused("rate_limited");
  const today = chicagoToday(now);
  if (!isLive(task, today)) return refused("not_found");
  if (client.bot) return refused("refused");
  const parsed = claimInput.safeParse(input);
  if (!parsed.success) return refused("invalid", badFields(parsed.error));
  const taskKey = `vol:claim:task:${task.id}`;
  // Counted only after a claim succeeds, so failed attempts never lock a task or a client out of others.
  const okTaskKey = `vol:claim:ok:${task.id}:${client.hash}`;
  const okAllKey = `vol:claim:okall:${client.hash}`;
  const datesKey = `vol:claim:dates:${client.hash}`;
  if (await atLimit(db, datesKey, VOLUNTEER_LIMITS.claimDatesPerClient, now)) return refused("rate_limited");
  if (await atLimit(db, taskKey, VOLUNTEER_LIMITS.claimPerTask, now)) return refused("rate_limited");
  if ((await atLimit(db, okTaskKey, VOLUNTEER_LIMITS.claimOkPerClientPerTask, now)) || (await atLimit(db, okAllKey, VOLUNTEER_LIMITS.claimOkPerClient, now))) return refused("rate_limited");
  if (isPast(task, today)) return refused("past");
  const { contact, key } = normalizeContact(parsed.data.contact)!;
  const [blocked] = await db
    .select({ k: volunteerTaskBlocks.contactKey })
    .from(volunteerTaskBlocks)
    .where(and(eq(volunteerTaskBlocks.taskId, task.id), eq(volunteerTaskBlocks.contactKey, key)))
    .limit(1);
  // Blocked and already-signed-up answer like any other refusal: no oracle on who signed up or was blocked.
  if (blocked) return refused("refused");
  const manageToken = newToken();
  const outcome = await db
    .transaction(async (tx) => {
      const [locked] = await tx.select().from(volunteerTasks).where(eq(volunteerTasks.id, task.id)).for("update");
      if (!locked || !isLive(locked, today) || isPast(locked, today)) throw new NoPlace("closed");
      const held = await tx.select({ key: volunteerClaims.contactKey }).from(volunteerClaims).where(and(eq(volunteerClaims.taskId, task.id), isNull(volunteerClaims.cancelledAt)));
      if (held.length >= locked.peopleNeeded) throw new NoPlace("full");
      if (held.some((h) => h.key === key)) return "already" as const;
      const [row] = await tx
        .insert(volunteerClaims)
        .values({ taskId: task.id, firstName: parsed.data.firstName, lastName: parsed.data.lastName, contact, contactKey: key, note: parsed.data.note ?? null, mayAskAgain: parsed.data.mayAskAgain, personRef, manageTokenHash: tokenHash(manageToken) })
        .returning({ id: volunteerClaims.id });
      await writeLinkAudit(tx, "volunteer", "volunteer_claim.create", "volunteer_claim", row.id, { volunteerTaskId: task.id, ...(task.groupId ? { volunteerGroupId: task.groupId } : {}) });
      return { id: row.id, task: locked };
    })
    .catch((error) => (error instanceof NoPlace ? error : Promise.reject(error)));
  if (outcome instanceof NoPlace) return refused(outcome.reason === "rate" ? "rate_limited" : outcome.reason);
  if (outcome === "already") return refused("refused");
  await withinLimit(db, taskKey, VOLUNTEER_LIMITS.claimPerTask, now);
  await withinLimit(db, okTaskKey, VOLUNTEER_LIMITS.claimOkPerClientPerTask, now);
  await withinLimit(db, okAllKey, VOLUNTEER_LIMITS.claimOkPerClient, now);
  await withinLimit(db, datesKey, VOLUNTEER_LIMITS.claimDatesPerClient, now);
  return { ok: true, claimId: outcome.id, manageToken, details: detailsOf(outcome.task) };
}

/** A claim against a token that matches nothing still counts against the client, then looks like any dead link. */
async function deadLink(db: Db, clientMeta: unknown, now: Date): Promise<Refused> {
  const client = readClient(clientMeta, now, true);
  if (client && !(await withinLimit(db, `vol:claim:client:${client.hash}`, VOLUNTEER_LIMITS.claimPerClient, now))) return refused("rate_limited");
  return refused("not_found");
}

/** Claim a task through its own link. */
/** `opts.personRef`: the opaque id from the volunteer first-party cookie, kept on the claim so their personal pages can list what they have taken. Never a contact. */
export async function claimTask(db: Db, token: unknown, input: unknown, clientMeta: unknown, now: Date = new Date(), opts: ClaimOptions = {}): Promise<ClaimResult> {
  const task = await liveTaskByToken(db, token, chicagoToday(now));
  return task ? claim(db, task, input, clientMeta, now, personRefOf(opts)) : deadLink(db, clientMeta, now);
}

/** Claim one evening of a shiva sheet. */
export async function claimOnSheet(db: Db, sheetToken: unknown, taskId: unknown, input: unknown, clientMeta: unknown, now: Date = new Date(), opts: ClaimOptions = {}): Promise<ClaimResult> {
  const group = await liveGroupByToken(db, sheetToken);
  const [task] = group && isUuid(taskId) ? await db.select().from(volunteerTasks).where(and(eq(volunteerTasks.id, taskId), eq(volunteerTasks.groupId, group.id))).limit(1) : [];
  return task ? claim(db, task, input, clientMeta, now, personRefOf(opts)) : deadLink(db, clientMeta, now);
}

/** Add a "bringing" line to a shiva sheet: 3 per client per sheet per hour, 40 on a sheet in all (counted under a lock on the sheet). */
export async function addBringing(db: Db, sheetToken: unknown, input: unknown, clientMeta: unknown, now: Date = new Date()): Promise<{ ok: true } | Refused> {
  const client = readClient(clientMeta, now, true);
  if (!client) return refused("invalid", ["clientMeta"]);
  if (!(await withinLimit(db, `vol:bring:client:${client.hash}`, VOLUNTEER_LIMITS.bringPerClient, now))) return refused("rate_limited");
  const group = await liveGroupByToken(db, sheetToken);
  if (!group) return refused("not_found");
  if (client.bot) return refused("refused");
  const parsed = bringingInput.safeParse(input);
  if (!parsed.success) return refused("invalid", badFields(parsed.error));
  const okKey = `vol:bring:ok:${group.id}:${client.hash}`;
  if (await atLimit(db, okKey, VOLUNTEER_LIMITS.bringOkPerClientPerSheet, now)) return refused("rate_limited");
  const added = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: volunteerGroups.id }).from(volunteerGroups).where(and(eq(volunteerGroups.id, group.id), isNull(volunteerGroups.cancelledAt))).for("update");
    if (!locked) return "gone" as const;
    const [{ n }] = await tx.select({ n: count() }).from(volunteerBringing).where(eq(volunteerBringing.groupId, group.id));
    if (n >= MAX_BRINGING) return "full" as const;
    await tx.insert(volunteerBringing).values({ groupId: group.id, ...parsed.data });
    await writeLinkAudit(tx, "volunteer", "volunteer_bringing.add", "volunteer_group", group.id, { volunteerGroupId: group.id });
    return "ok" as const;
  });
  if (added === "gone") return refused("not_found");
  if (added === "full") return refused("full");
  await withinLimit(db, okKey, VOLUNTEER_LIMITS.bringOkPerClientPerSheet, now);
  return { ok: true };
}

// ─── by personal token ────────────────────────────────────────────────────────────────

type Mine = { claim: Claim; task: Task };

async function byManageToken(db: Db, token: unknown): Promise<Mine | null> {
  const [row] = await db
    .select({ claim: volunteerClaims, task: volunteerTasks })
    .from(volunteerClaims)
    .innerJoin(volunteerTasks, eq(volunteerTasks.id, volunteerClaims.taskId))
    // A purged claim's link stops resolving: its hash is gone.
    .where(and(eq(volunteerClaims.manageTokenHash, tokenHash(token)), isNull(volunteerClaims.purgedAt)))
    .limit(1);
  return row ?? null;
}

type MyState = "active" | "cancelled" | "done" | "task_cancelled" | "passed";

function stateOf({ claim: c, task }: Mine): MyState {
  if (c.cancelledAt) return "cancelled";
  if (c.doneAt || task.status === "done") return "done";
  return task.status === "cancelled" ? "task_cancelled" : "active";
}

export type MyClaim =
  | { state: "active"; details: ClaimDetails; past: boolean; firstName: string | null }
  /** No longer something to do: the place and the contact line are not given. */
  | { state: Exclude<MyState, "active">; kind: Kind; forLabel: string; date: string };

function view({ claim: c, task }: Mine, now: Date): MyClaim {
  const state = stateOf({ claim: c, task });
  if (state !== "active") return { state, kind: task.kind, forLabel: task.forLabel, date: task.taskDate };
  const today = chicagoToday(now);
  // The place and the contact line are given only while the task is live (through the day after its date).
  if (today > lastViewDay(task)) return { state: "passed", kind: task.kind, forLabel: task.forLabel, date: task.taskDate };
  return { state, details: detailsOf(task), past: isPast(task, today), firstName: c.firstName };
}

/** A volunteer's own claim: where and when while it stands. Null: no such link (or purged). */
export async function getMyClaim(db: Db, manageToken: unknown, now: Date = new Date()): Promise<MyClaim | null> {
  const mine = await byManageToken(db, manageToken);
  return mine ? view(mine, now) : null;
}

async function manageAttempt(db: Db, manageToken: unknown, clientMeta: unknown, now: Date): Promise<Mine | Refused> {
  const client = readClient(clientMeta, now, false);
  if (!client) return refused("invalid", ["clientMeta"]);
  if (!(await withinLimit(db, `vol:manage:client:${client.hash}`, VOLUNTEER_LIMITS.managePerClient, now))) return refused("rate_limited");
  return (await byManageToken(db, manageToken)) ?? refused("not_found");
}

/** Give the place back. Only while the claim stands and the date has not passed. Cancelling twice is not an error. */
export async function cancelMyClaim(db: Db, manageToken: unknown, clientMeta: unknown, now: Date = new Date()): Promise<{ ok: true } | Refused> {
  const mine = await manageAttempt(db, manageToken, clientMeta, now);
  if ("ok" in mine) return mine;
  if (mine.claim.cancelledAt) return { ok: true };
  if (stateOf(mine) !== "active" || isPast(mine.task, chicagoToday(now))) return refused("closed");
  const gaveBack = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(volunteerClaims)
      .set({ cancelledAt: now, cancelledBy: "volunteer" })
      .where(and(eq(volunteerClaims.id, mine.claim.id), isNull(volunteerClaims.cancelledAt), isNull(volunteerClaims.doneAt)))
      .returning({ id: volunteerClaims.id });
    if (row) await writeLinkAudit(tx, "volunteer", "volunteer_claim.cancel", "volunteer_claim", row.id, { volunteerTaskId: mine.task.id });
    return row !== undefined;
  });
  // The coordinators hear (fixed words, after the response) when a place is given back close to its date.
  if (gaveBack) afterResponse(() => noticePlaceOpened(db, { taskIds: [mine.task.id] }, now));
  return { ok: true };
}

/** Say it was done, with an optional line back to the poster. Once only. */
export async function markMyClaimDone(db: Db, manageToken: unknown, note: unknown, clientMeta: unknown, now: Date = new Date()): Promise<{ ok: true } | Refused> {
  const mine = await manageAttempt(db, manageToken, clientMeta, now);
  if ("ok" in mine) return mine;
  if (stateOf(mine) !== "active") return refused("closed");
  const parsed = doneInput.safeParse(note === "" ? null : note);
  if (!parsed.success) return refused("invalid", ["note"]);
  const done = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(volunteerClaims)
      .set({ doneAt: now, doneNote: parsed.data ?? null })
      .where(and(eq(volunteerClaims.id, mine.claim.id), isNull(volunteerClaims.cancelledAt), isNull(volunteerClaims.doneAt)))
      .returning({ id: volunteerClaims.id });
    if (row) await writeLinkAudit(tx, "volunteer", "volunteer_claim.done", "volunteer_claim", row.id, { volunteerTaskId: mine.task.id });
    return row;
  });
  return done ? { ok: true } : refused("closed");
}

/** The task as a calendar file, while the claim stands. Null otherwise. */
export async function claimIcs(db: Db, manageToken: unknown, now: Date = new Date()): Promise<string | null> {
  const mine = await byManageToken(db, manageToken);
  if (!mine || stateOf(mine) !== "active" || chicagoToday(now) > lastViewDay(mine.task)) return null;
  return volunteerIcs({ uid: mine.claim.id, kind: mine.task.kind, forLabel: mine.task.forLabel, date: mine.task.taskDate, timeWindow: mine.task.timeWindow, place: mine.task.place, stamp: now });
}

// ─── "I can do this every time" ──────────────────────────────────────────────────────

export type EveryTimeResult = { ok: true; manageToken: string; count: number } | Refused;

/**
 * Claim every open occurrence of the task's series for one volunteer, in one transaction: each occurrence with a
 * place left, no block and no claim of theirs already is taken together or none is. They share one personal page
 * (the first claim holds its link). The caps count once per series, as one claim: one every-time claim is one
 * success against the per-task and per-client limits, whatever the number of dates.
 */
export async function claimEveryTime(db: Db, token: unknown, input: unknown, clientMeta: unknown, now: Date = new Date(), opts: ClaimOptions = {}): Promise<EveryTimeResult> {
  const today = chicagoToday(now);
  const task = await liveTaskByToken(db, token, today);
  if (!task) return deadLink(db, clientMeta, now);
  const client = readClient(clientMeta, now, true);
  if (!client) return refused("invalid", ["clientMeta"]);
  if (!(await withinLimit(db, `vol:claim:client:${client.hash}`, VOLUNTEER_LIMITS.claimPerClient, now))) return refused("rate_limited");
  if (client.bot) return refused("refused");
  const seriesId = task.seriesId;
  if (!seriesId) return refused("refused");
  const parsed = claimInput.safeParse(input);
  if (!parsed.success) return refused("invalid", badFields(parsed.error));
  const seriesKey = `vol:claim:task:${seriesId}`;
  const okSeriesKey = `vol:claim:ok:${seriesId}:${client.hash}`;
  const okAllKey = `vol:claim:okall:${client.hash}`;
  const datesKey = `vol:claim:dates:${client.hash}`;
  const personRef = personRefOf(opts);
  if (await atLimit(db, datesKey, VOLUNTEER_LIMITS.claimDatesPerClient, now)) return refused("rate_limited");
  if (await atLimit(db, seriesKey, VOLUNTEER_LIMITS.claimPerTask, now)) return refused("rate_limited");
  if ((await atLimit(db, okSeriesKey, VOLUNTEER_LIMITS.claimOkPerClientPerTask, now)) || (await atLimit(db, okAllKey, VOLUNTEER_LIMITS.claimOkPerClient, now))) return refused("rate_limited");
  const { contact, key } = normalizeContact(parsed.data.contact)!;
  const manageToken = newToken();
  const setId = randomUUID();
  const made = await db.transaction(async (tx) => {
    const occurrences = await tx
      .select()
      .from(volunteerTasks)
      .where(and(eq(volunteerTasks.seriesId, seriesId), eq(volunteerTasks.status, "open"), gte(volunteerTasks.taskDate, today)))
      .orderBy(asc(volunteerTasks.taskDate), asc(volunteerTasks.id))
      .for("update");
    if (occurrences.length === 0) return { none: "closed" as const };
    const ids = occurrences.map((o) => o.id);
    const held = await tx.select({ taskId: volunteerClaims.taskId, key: volunteerClaims.contactKey }).from(volunteerClaims).where(and(inArray(volunteerClaims.taskId, ids), isNull(volunteerClaims.cancelledAt)));
    const blocked = await tx.select({ taskId: volunteerTaskBlocks.taskId }).from(volunteerTaskBlocks).where(and(inArray(volunteerTaskBlocks.taskId, ids), eq(volunteerTaskBlocks.contactKey, key)));
    const blockedIds = new Set(blocked.map((b) => b.taskId));
    // Taken off this series by a poster: answers like any other refusal, never "full".
    if (blockedIds.size > 0) return { none: "blocked" as const };
    const open = occurrences.filter((o) => {
      const here = held.filter((h) => h.taskId === o.id);
      return !blockedIds.has(o.id) && here.length < o.peopleNeeded && !here.some((h) => h.key === key);
    });
    if (open.length === 0) return { none: "full" as const };
    // One client takes at most 26 dates an hour in all, whether one at a time or in one "every time" claim.
    if ((await countOf(tx, datesKey, now)) + open.length > VOLUNTEER_LIMITS.claimDatesPerClient) return { none: "rate" as const };
    const rows = await tx
      .insert(volunteerClaims)
      .values(
        open.map((o, i) => ({
          taskId: o.id,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          contact,
          contactKey: key,
          note: parsed.data.note ?? null,
          mayAskAgain: parsed.data.mayAskAgain,
          claimSetId: setId,
          personRef,
          manageTokenHash: i === 0 ? tokenHash(manageToken) : null,
        })),
      )
      .returning({ id: volunteerClaims.id });
    await writeLinkAudit(tx, "volunteer", "volunteer_claim.every_time", "volunteer_claim", rows[0].id, { volunteerSeriesId: seriesId, count: rows.length });
    return { count: rows.length };
  });
  if ("none" in made) return refused(made.none === "full" ? "full" : made.none === "rate" ? "rate_limited" : made.none === "blocked" ? "refused" : "closed");
  await withinLimit(db, seriesKey, VOLUNTEER_LIMITS.claimPerTask, now);
  await withinLimit(db, okSeriesKey, VOLUNTEER_LIMITS.claimOkPerClientPerTask, now);
  await withinLimit(db, okAllKey, VOLUNTEER_LIMITS.claimOkPerClient, now);
  await addToLimit(db, datesKey, made.count, now);
  return { ok: true, manageToken, count: made.count };
}

export type MyDate = { claimId: string; kind: Kind; forLabel: string; date: string; timeWindow: string | null; state: MyState; needed: string | null; place: string | null; cancellable: boolean };
export type MySeries = { firstName: string | null; dates: MyDate[] };

/** The personal page of an every-time claim, from the first claim's link: every date with its state. The place only while a date stands and is live. Null when the link is not an every-time one. */
export async function getMySeries(db: Db, manageToken: unknown, now: Date = new Date()): Promise<MySeries | null> {
  const mine = await byManageToken(db, manageToken);
  if (!mine || !mine.claim.claimSetId) return null;
  const rows = await db
    .select({ claim: volunteerClaims, task: volunteerTasks })
    .from(volunteerClaims)
    .innerJoin(volunteerTasks, eq(volunteerTasks.id, volunteerClaims.taskId))
    .where(and(eq(volunteerClaims.claimSetId, mine.claim.claimSetId), isNull(volunteerClaims.purgedAt)))
    .orderBy(asc(volunteerTasks.taskDate));
  const today = chicagoToday(now);
  return {
    firstName: mine.claim.firstName,
    dates: rows.map((r) => {
      const state = stateOf(r);
      const live = state === "active" && today <= lastViewDay(r.task);
      return {
        claimId: r.claim.id,
        kind: r.task.kind,
        forLabel: r.task.forLabel,
        date: r.task.taskDate,
        timeWindow: r.task.timeWindow,
        state: state === "active" && !live ? ("passed" as const) : state,
        needed: live ? r.task.needed : null,
        place: live ? r.task.place : null,
        cancellable: live && !isPast(r.task, today),
      };
    }),
  };
}

/** Give back one date of an every-time claim, or all of those still ahead (`claimId` null). Only claims in this link's own set. */
export async function cancelMySeries(db: Db, manageToken: unknown, claimId: unknown, clientMeta: unknown, now: Date = new Date()): Promise<{ ok: true; cancelled: number } | Refused> {
  const mine = await manageAttempt(db, manageToken, clientMeta, now);
  if ("ok" in mine) return mine;
  const setId = mine.claim.claimSetId;
  if (!setId) return refused("closed");
  const today = chicagoToday(now);
  const one = claimId === null || claimId === undefined || claimId === "" ? null : claimId;
  if (one !== null && !isUuid(one)) return refused("invalid", ["claimId"]);
  const futureTasks = db.select({ id: volunteerTasks.id }).from(volunteerTasks).where(gte(volunteerTasks.taskDate, today));
  const rows = await db.transaction(async (tx) => {
    const done = await tx
      .update(volunteerClaims)
      .set({ cancelledAt: now, cancelledBy: "volunteer" })
      .where(and(eq(volunteerClaims.claimSetId, setId), isNull(volunteerClaims.cancelledAt), isNull(volunteerClaims.doneAt), inArray(volunteerClaims.taskId, futureTasks), ...(one ? [eq(volunteerClaims.id, one)] : [])))
      .returning({ id: volunteerClaims.id, taskId: volunteerClaims.taskId });
    for (const r of done) await writeLinkAudit(tx, "volunteer", "volunteer_claim.cancel", "volunteer_claim", r.id, { volunteerTaskId: r.taskId });
    return done;
  });
  if (rows.length > 0) afterResponse(() => noticePlaceOpened(db, { taskIds: [...new Set(rows.map((r) => r.taskId))] }, now));
  return { ok: true, cancelled: rows.length };
}

export type Commitment = { kind: Kind; forLabel: string; date: string; timeWindow: string | null };

/**
 * What this person has taken on elsewhere, from a personal link of theirs: the live claims that carry the same opaque
 * `person_ref` (the id in the first-party cookie set when they claimed on this device), apart from this link's own
 * claim and its own "every time" set, which have their own listing. NOTHING is matched by email or mobile: typing
 * someone else's contact into a claim links nothing to that person. Kind, label and time only (never a place, a
 * contact line or a task link), and only for a link that is itself live and for claims that are open, ahead and
 * not purged.
 */
export async function getMyCommitments(db: Db, manageToken: unknown, now: Date = new Date()): Promise<Commitment[]> {
  const mine = await byManageToken(db, manageToken);
  if (!mine || !mine.claim.personRef || stateOf(mine) !== "active") return [];
  const today = chicagoToday(now);
  const rows = await db
    .select({ task: volunteerTasks, claimId: volunteerClaims.id, setId: volunteerClaims.claimSetId })
    .from(volunteerClaims)
    .innerJoin(volunteerTasks, eq(volunteerTasks.id, volunteerClaims.taskId))
    .where(and(eq(volunteerClaims.personRef, mine.claim.personRef), isNull(volunteerClaims.cancelledAt), isNull(volunteerClaims.purgedAt), eq(volunteerTasks.status, "open"), gte(volunteerTasks.taskDate, today)))
    .orderBy(asc(volunteerTasks.taskDate));
  return rows
    .filter((r) => r.claimId !== mine.claim.id && !(mine.claim.claimSetId && r.setId === mine.claim.claimSetId))
    .map((r) => ({ kind: r.task.kind, forLabel: r.task.forLabel, date: r.task.taskDate, timeWindow: r.task.timeWindow }));
}
