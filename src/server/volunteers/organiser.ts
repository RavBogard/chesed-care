/**
 * The poster's side of volunteer tasks: post, edit, cancel and finish a task or a shiva
 * sheet, see who claimed (name and contact), remove a claim, keep a board link, and read
 * the "ask me again" list. Every function takes the acting user and asks the access policy
 * (src/server/access/policy.ts). A task is linked to a care item only by someone with full
 * sight of it, and the link is shown only to those who can fully read the item; nothing
 * of the care record is ever copied into a task.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  canLinkVolunteerTaskToCareItem,
  canMakeVolunteerBoard,
  canPostVolunteerTasks,
  canSeeVolunteerTask,
  canSeeVolunteerTaskCareLink,
  deny,
  namedOn,
  volunteerTaskVisibleWhere,
  type Actor,
} from "@/server/access/policy";
import { writeAudit, type AuditAction } from "@/server/care/audit";
import { loadVisibleCareItemAccess } from "@/server/care/care-items";
import { InvalidInput, NotFound, uuidOrNotFound } from "@/server/care/validate";
import { careItems, volunteerBoards, volunteerBringing, volunteerClaims, volunteerGroups, volunteerTaskBlocks, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { newToken, tokenHash } from "@/server/meals/tokens";
import { MINYAN_DEFAULT_NEEDED } from "@/lib/volunteers-wording";
import { activeCounts, isLive, isPast, placesLeft, type Claim, type Task } from "./core";
import { createSheetInput, createTaskInput, MINYAN, parse, taskPatch } from "./input";

/** Where the poster runs a task in the app. */
export const volunteerTaskPath = (id: string) => `/volunteers/${id}`;

/** Finished and cancelled tasks stay on the list for this many days after their date. */
const LIST_DAYS = 45;

export type ClaimView = Pick<Claim, "id" | "firstName" | "lastName" | "contact" | "note" | "mayAskAgain" | "createdAt" | "cancelledAt" | "cancelledBy" | "doneAt" | "doneNote"> & { forgotten: boolean; /** Taken with "I can do this every time": one removal can take them off every date. */ everyTime: boolean };

export type TaskView = {
  id: string;
  groupId: string | null;
  /** The repeating series this is one occurrence of, if any. */
  seriesId: string | null;
  kind: Task["kind"];
  forLabel: string;
  needed: string;
  date: string;
  timeWindow: string | null;
  place: string | null;
  peopleNeeded: number;
  contactLine: string | null;
  status: Task["status"];
  taken: number;
  placesLeft: number;
  /** Null for an evening on a sheet (the sheet has the link), and once purged. */
  publicToken: string | null;
  /** Null unless the actor fully reads the care item. */
  careItemId: string | null;
  mine: boolean;
  past: boolean;
  /** Most recent first; cancelled ones are kept in sight, with who cancelled. */
  claims: ClaimView[];
  today: string;
};

export type Loaded = { task: Task; careLinkVisible: boolean };

/** A task the actor may manage, or NotFound (missing and hidden look the same). */
export async function loadTask(db: Db, actor: Actor, id: unknown): Promise<Loaded> {
  if (!canPostVolunteerTasks(actor)) deny();
  const [row] = await db
    .select({ task: volunteerTasks, item: careItems, named: namedOn(actor) })
    .from(volunteerTasks)
    .leftJoin(careItems, eq(careItems.id, volunteerTasks.careItemId))
    .where(eq(volunteerTasks.id, uuidOrNotFound(id)))
    .limit(1);
  if (!row) throw new NotFound();
  const item = row.item ? { ...row.item, named: row.named === true } : null;
  if (!canSeeVolunteerTask(actor, { createdBy: row.task.createdBy, careItem: item })) throw new NotFound();
  return { task: row.task, careLinkVisible: canSeeVolunteerTaskCareLink(actor, item) };
}

const claimView = (c: Claim): ClaimView => ({
  id: c.id,
  firstName: c.firstName,
  lastName: c.lastName,
  contact: c.contact,
  note: c.note,
  mayAskAgain: c.mayAskAgain,
  createdAt: c.createdAt,
  cancelledAt: c.cancelledAt,
  cancelledBy: c.cancelledBy,
  doneAt: c.doneAt,
  doneNote: c.doneNote,
  forgotten: c.purgedAt !== null && c.contact === null,
  everyTime: c.claimSetId !== null,
});

async function viewOf(db: Db, actor: Actor, { task, careLinkVisible }: Loaded, now: Date): Promise<TaskView> {
  const today = chicagoToday(now);
  const claims = await db.select().from(volunteerClaims).where(eq(volunteerClaims.taskId, task.id)).orderBy(desc(volunteerClaims.createdAt));
  const taken = claims.filter((c) => !c.cancelledAt).length;
  return {
    id: task.id,
    groupId: task.groupId,
    seriesId: task.seriesId,
    kind: task.kind,
    forLabel: task.forLabel,
    needed: task.needed,
    date: task.taskDate,
    timeWindow: task.timeWindow,
    place: task.place,
    peopleNeeded: task.peopleNeeded,
    contactLine: task.contactLine,
    status: task.status,
    taken,
    placesLeft: placesLeft(task, taken),
    publicToken: task.publicToken,
    careItemId: careLinkVisible ? task.careItemId : null,
    mine: task.createdBy === actor.id,
    past: isPast(task, today),
    claims: claims.map(claimView),
    today,
  };
}

export async function getVolunteerTask(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<TaskView> {
  return viewOf(db, actor, await loadTask(db, actor, id), now);
}

/** The care item a task or sheet is about: only one the actor fully reads (restricted or not), else NotFound. */
export async function careItemFor(db: Db, actor: Actor, careItemId: unknown): Promise<string | null> {
  if (careItemId === undefined || careItemId === null || careItemId === "") return null;
  const { item, access } = await loadVisibleCareItemAccess(db, actor, careItemId);
  if (!canLinkVolunteerTaskToCareItem(actor, access)) throw new NotFound();
  return item.id;
}

/** A new task is open at once; its link is made here. Shiva minyan defaults to ten people. */
export async function createVolunteerTask(db: Db, actor: Actor, input: unknown, now: Date = new Date()): Promise<TaskView> {
  if (!canPostVolunteerTasks(actor)) deny();
  const { careItemId, date, peopleNeeded, ...fields } = parse(createTaskInput, input);
  if (date < chicagoToday(now)) throw new InvalidInput("date");
  const linked = await careItemFor(db, actor, careItemId);
  const publicToken = newToken();
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(volunteerTasks)
      .values({
        kind: fields.kind,
        forLabel: fields.forLabel,
        needed: fields.needed,
        timeWindow: fields.timeWindow ?? null,
        place: fields.place ?? null,
        contactLine: fields.contactLine ?? null,
        taskDate: date,
        peopleNeeded: peopleNeeded ?? (fields.kind === "shiva_minyan" ? MINYAN : 1),
        careItemId: linked,
        publicToken,
        publicTokenHash: tokenHash(publicToken),
        createdBy: actor.id,
      })
      .returning({ id: volunteerTasks.id });
    await writeAudit(tx, actor, "volunteer_task.create", "volunteer_task", row.id, { by: "organiser", volunteerTaskId: row.id, careItemId: linked });
    return row.id;
  });
  return getVolunteerTask(db, actor, id, now);
}

/** Change the words, date, place, count or contact line of an open task. Not who can see it, nor its links. */
export async function updateVolunteerTask(db: Db, actor: Actor, id: unknown, patch: unknown, now: Date = new Date()): Promise<TaskView> {
  const loaded = await loadTask(db, actor, id);
  const { date, ...rest } = parse(taskPatch, patch);
  if (loaded.task.status !== "open") throw new InvalidInput("status");
  if (date !== undefined && date < chicagoToday(now) && date !== loaded.task.taskDate) throw new InvalidInput("date");
  const held = (await activeCounts(db, [loaded.task.id])).get(loaded.task.id) ?? 0;
  if (rest.peopleNeeded !== undefined && rest.peopleNeeded < held) throw new InvalidInput("peopleNeeded");
  const set = { ...rest, ...(date !== undefined ? { taskDate: date } : {}) };
  if (Object.keys(set).length)
    await db.transaction(async (tx) => {
      await tx.update(volunteerTasks).set(set).where(eq(volunteerTasks.id, loaded.task.id));
      await writeAudit(tx, actor, "volunteer_task.update", "volunteer_task", loaded.task.id, { by: "organiser", volunteerTaskId: loaded.task.id });
    });
  return getVolunteerTask(db, actor, loaded.task.id, now);
}

async function finish(db: Db, actor: Actor, id: unknown, to: "done" | "cancelled", action: AuditAction, now: Date): Promise<TaskView> {
  const loaded = await loadTask(db, actor, id);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(volunteerTasks)
      .set({ status: to, ...(to === "done" ? { doneAt: now } : { cancelledAt: now }) })
      .where(and(eq(volunteerTasks.id, loaded.task.id), eq(volunteerTasks.status, "open")))
      .returning({ id: volunteerTasks.id });
    if (!row) throw new InvalidInput("status");
    await writeAudit(tx, actor, action, "volunteer_task", row.id, { by: "organiser", volunteerTaskId: row.id });
  });
  return getVolunteerTask(db, actor, loaded.task.id, now);
}

/** Cancelling stops the link at once. Volunteers who had claimed are told, on their own page, that it is cancelled. */
export const cancelVolunteerTask = (db: Db, actor: Actor, id: unknown, now: Date = new Date()) => finish(db, actor, id, "cancelled", "volunteer_task.cancel", now);
export const markVolunteerTaskDone = (db: Db, actor: Actor, id: unknown, now: Date = new Date()) => finish(db, actor, id, "done", "volunteer_task.done", now);

/**
 * Take a volunteer's place away. Their name and contact stay in sight and are kept, but they are never
 * offered for asking again. `block`: that contact cannot claim this task again.
 */
export async function removeClaim(db: Db, actor: Actor, claimId: unknown, block: boolean, now: Date = new Date()): Promise<TaskView> {
  const [row] = await db.select({ claim: volunteerClaims }).from(volunteerClaims).where(eq(volunteerClaims.id, uuidOrNotFound(claimId))).limit(1);
  if (!row) throw new NotFound();
  const { task } = await loadTask(db, actor, row.claim.taskId);
  if (row.claim.cancelledAt) throw new InvalidInput("claim");
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .update(volunteerClaims)
      .set({ cancelledAt: now, cancelledBy: "poster" })
      .where(and(eq(volunteerClaims.id, row.claim.id), isNull(volunteerClaims.cancelledAt)))
      .returning({ id: volunteerClaims.id });
    if (!gone) throw new InvalidInput("claim");
    const blocking = block && row.claim.contactKey !== null;
    if (blocking) await tx.insert(volunteerTaskBlocks).values({ taskId: task.id, contactKey: row.claim.contactKey!, blockedBy: actor.id }).onConflictDoNothing();
    await writeAudit(tx, actor, "volunteer_claim.remove", "volunteer_claim", gone.id, { by: "organiser", volunteerTaskId: task.id, blocked: blocking });
  });
  return getVolunteerTask(db, actor, task.id, now);
}

/**
 * Take an "every time" volunteer off every date of the series at once (those they hold; given-back ones stay as they
 * are). `block`: that contact cannot claim any date of the series again, one by one or "every time". Their name and
 * contact stay in sight, as for any removed claim, and are never offered for asking again.
 */
export async function removeFromAllDates(db: Db, actor: Actor, claimId: unknown, block: boolean, now: Date = new Date()): Promise<TaskView> {
  const [row] = await db.select({ claim: volunteerClaims }).from(volunteerClaims).where(eq(volunteerClaims.id, uuidOrNotFound(claimId))).limit(1);
  if (!row) throw new NotFound();
  const { task } = await loadTask(db, actor, row.claim.taskId);
  const setId = row.claim.claimSetId;
  if (!setId) return removeClaim(db, actor, claimId, block, now);
  await db.transaction(async (tx) => {
    const gone = await tx
      .update(volunteerClaims)
      .set({ cancelledAt: now, cancelledBy: "poster" })
      .where(and(eq(volunteerClaims.claimSetId, setId), isNull(volunteerClaims.cancelledAt), isNull(volunteerClaims.doneAt)))
      .returning({ id: volunteerClaims.id, taskId: volunteerClaims.taskId });
    if (gone.length === 0) throw new InvalidInput("claim");
    const key = row.claim.contactKey;
    if (block && key !== null) {
      const dates = task.seriesId ? await tx.select({ id: volunteerTasks.id }).from(volunteerTasks).where(eq(volunteerTasks.seriesId, task.seriesId)) : gone.map((g) => ({ id: g.taskId }));
      if (dates.length) await tx.insert(volunteerTaskBlocks).values(dates.map((d) => ({ taskId: d.id, contactKey: key, blockedBy: actor.id }))).onConflictDoNothing();
    }
    for (const g of gone) await writeAudit(tx, actor, "volunteer_claim.remove", "volunteer_claim", g.id, { by: "organiser", volunteerTaskId: g.taskId, blocked: block && key !== null });
  });
  return getVolunteerTask(db, actor, task.id, now);
}

// ─── the list ─────────────────────────────────────────────────────────────────────────

export type TaskSection = "needs_people" | "filled" | "finished";
export type TaskSummary = Pick<TaskView, "id" | "kind" | "forLabel" | "date" | "status" | "taken" | "peopleNeeded" | "placesLeft" | "mine" | "past"> & { section: TaskSection };
export type SheetSummary = { groupId: string; title: string; evenings: number; evenFilled: number; nextDate: string | null; mine: boolean; section: TaskSection };

const sectionOf = (t: Pick<Task, "status" | "taskDate">, left: number, today: string): TaskSection => (t.status !== "open" || t.taskDate < today ? "finished" : left === 0 ? "filled" : "needs_people");

/**
 * The tasks and sheets the actor may see: those that need people first (none taken before
 * some taken, the actor's own first), then filled, then finished.
 */
export async function listVolunteerTasks(db: Db, actor: Actor, now: Date = new Date()): Promise<{ today: string; tasks: TaskSummary[]; sheets: SheetSummary[] }> {
  if (!canPostVolunteerTasks(actor)) deny();
  const today = chicagoToday(now);
  const rows = await db
    .select({ task: volunteerTasks, groupTitle: volunteerGroups.title })
    .from(volunteerTasks)
    .leftJoin(volunteerGroups, eq(volunteerGroups.id, volunteerTasks.groupId))
    .where(and(volunteerTaskVisibleWhere(actor), gte(volunteerTasks.taskDate, addDays(today, -LIST_DAYS))))
    .orderBy(asc(volunteerTasks.taskDate), asc(volunteerTasks.createdAt));
  const counts = await activeCounts(db, rows.map((r) => r.task.id));
  const rank: Record<TaskSection, number> = { needs_people: 0, filled: 1, finished: 2 };
  const withLeft = rows.map((r) => ({ ...r, taken: counts.get(r.task.id) ?? 0, left: placesLeft(r.task, counts.get(r.task.id) ?? 0) }));
  const tasks: TaskSummary[] = withLeft
    .filter((r) => !r.task.groupId)
    .map((r) => ({
      id: r.task.id,
      kind: r.task.kind,
      forLabel: r.task.forLabel,
      date: r.task.taskDate,
      status: r.task.status,
      taken: r.taken,
      peopleNeeded: r.task.peopleNeeded,
      placesLeft: r.left,
      mine: r.task.createdBy === actor.id,
      past: r.task.taskDate < today,
      section: sectionOf(r.task, r.left, today),
    }))
    .sort((a, b) => rank[a.section] - rank[b.section] || Number(b.mine) - Number(a.mine) || Number(a.taken > 0) - Number(b.taken > 0) || a.date.localeCompare(b.date));
  const groups = new Map<string, typeof withLeft>();
  for (const r of withLeft) if (r.task.groupId) groups.set(r.task.groupId, [...(groups.get(r.task.groupId) ?? []), r]);
  const sheets: SheetSummary[] = [...groups.entries()]
    .map(([groupId, list]) => {
      const live = list.filter((r) => r.task.status === "open" && r.task.taskDate >= today);
      return {
        groupId,
        title: list[0].groupTitle ?? "",
        evenings: list.length,
        evenFilled: live.filter((r) => r.left === 0).length,
        nextDate: live[0]?.task.taskDate ?? null,
        mine: list[0].task.createdBy === actor.id,
        section: (live.length === 0 ? "finished" : live.every((r) => r.left === 0) ? "filled" : "needs_people") as TaskSection,
      };
    })
    .sort((a, b) => rank[a.section] - rank[b.section] || Number(b.mine) - Number(a.mine) || (a.nextDate ?? "").localeCompare(b.nextDate ?? ""));
  return { today, tasks, sheets };
}

/** On a care item: its tasks (status and places only), for the clergy who fully read the item. The caller passes only items the actor fully reads. */
export type CareItemTask = Pick<TaskSummary, "id" | "kind" | "forLabel" | "date" | "status" | "taken" | "peopleNeeded" | "placesLeft" | "section"> & {
  careItemId: string;
  /** The public link still opens: the task is open and its date is not more than a day gone. */
  linkOpen: boolean;
};
export async function listTasksForCareItems(db: Db, actor: Actor, careItemIds: string[], now: Date = new Date()): Promise<CareItemTask[]> {
  if (!canPostVolunteerTasks(actor) || careItemIds.length === 0) return [];
  const today = chicagoToday(now);
  const rows = await db
    .select()
    .from(volunteerTasks)
    .where(and(inArray(volunteerTasks.careItemId, careItemIds), volunteerTaskVisibleWhere(actor)))
    .orderBy(desc(volunteerTasks.taskDate));
  const counts = await activeCounts(db, rows.map((t) => t.id));
  return rows.map((t) => {
    const taken = counts.get(t.id) ?? 0;
    const left = placesLeft(t, taken);
    return { id: t.id, careItemId: t.careItemId!, kind: t.kind, forLabel: t.forLabel, date: t.taskDate, status: t.status, taken, peopleNeeded: t.peopleNeeded, placesLeft: left, section: sectionOf(t, left, today), linkOpen: isLive(t, today) };
  });
}

// ─── shiva sheets ─────────────────────────────────────────────────────────────────────

export type BringingView = { id: string; firstName: string; line: string };
export type SheetView = { id: string; title: string; publicToken: string | null; careItemId: string | null; mine: boolean; cancelled: boolean; evenings: TaskView[]; bringing: BringingView[] };

async function loadGroup(db: Db, actor: Actor, id: unknown) {
  if (!canPostVolunteerTasks(actor)) deny();
  const groupId = uuidOrNotFound(id);
  const [row] = await db
    .select({ group: volunteerGroups, item: careItems, named: namedOn(actor) })
    .from(volunteerGroups)
    .leftJoin(careItems, eq(careItems.id, volunteerGroups.careItemId))
    .where(eq(volunteerGroups.id, groupId))
    .limit(1);
  if (!row) throw new NotFound();
  const item = row.item ? { ...row.item, named: row.named === true } : null;
  if (!canSeeVolunteerTask(actor, { createdBy: row.group.createdBy, careItem: item })) throw new NotFound();
  return { group: row.group, careLinkVisible: canSeeVolunteerTaskCareLink(actor, item) };
}

/** A shiva sheet: one link, an evening for each date (a minyan slot counting toward ten) and an optional "bringing" list. */
export async function createVolunteerSheet(db: Db, actor: Actor, input: unknown, now: Date = new Date()): Promise<SheetView> {
  if (!canPostVolunteerTasks(actor)) deny();
  const { title, needed, place, contactLine, evenings, careItemId } = parse(createSheetInput, input);
  const today = chicagoToday(now);
  if (evenings.some((e) => e.date < today)) throw new InvalidInput("evenings");
  const linked = await careItemFor(db, actor, careItemId);
  const publicToken = newToken();
  const id = await db.transaction(async (tx) => {
    const [group] = await tx.insert(volunteerGroups).values({ title, careItemId: linked, createdBy: actor.id, publicToken, publicTokenHash: tokenHash(publicToken) }).returning({ id: volunteerGroups.id });
    await tx.insert(volunteerTasks).values(
      [...new Map(evenings.map((e) => [e.date, e])).values()].map((e) => ({
        groupId: group.id,
        kind: "shiva_minyan" as const,
        forLabel: title,
        needed: needed ?? MINYAN_DEFAULT_NEEDED,
        taskDate: e.date,
        timeWindow: e.timeWindow ?? null,
        place: place ?? null,
        contactLine: contactLine ?? null,
        peopleNeeded: MINYAN,
        careItemId: linked,
        createdBy: actor.id,
      })),
    );
    await writeAudit(tx, actor, "volunteer_sheet.create", "volunteer_group", group.id, { by: "organiser", volunteerGroupId: group.id, count: evenings.length, careItemId: linked });
    return group.id;
  });
  return getVolunteerSheet(db, actor, id, now);
}

export async function getVolunteerSheet(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<SheetView> {
  const { group, careLinkVisible } = await loadGroup(db, actor, id);
  const tasks = await db.select().from(volunteerTasks).where(eq(volunteerTasks.groupId, group.id)).orderBy(asc(volunteerTasks.taskDate));
  const evenings = await Promise.all(tasks.map((task) => viewOf(db, actor, { task, careLinkVisible }, now)));
  const bringing = await db.select({ id: volunteerBringing.id, firstName: volunteerBringing.firstName, line: volunteerBringing.line }).from(volunteerBringing).where(eq(volunteerBringing.groupId, group.id)).orderBy(asc(volunteerBringing.createdAt));
  return { id: group.id, title: group.title, publicToken: group.publicToken, careItemId: careLinkVisible ? group.careItemId : null, mine: group.createdBy === actor.id, cancelled: group.cancelledAt !== null, evenings, bringing };
}

/** Cancel the whole sheet: the link stops and every open evening is cancelled. */
export async function cancelVolunteerSheet(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<SheetView> {
  const { group } = await loadGroup(db, actor, id);
  await db.transaction(async (tx) => {
    const [row] = await tx.update(volunteerGroups).set({ cancelledAt: now }).where(and(eq(volunteerGroups.id, group.id), isNull(volunteerGroups.cancelledAt))).returning({ id: volunteerGroups.id });
    if (!row) throw new InvalidInput("status");
    await tx.update(volunteerTasks).set({ status: "cancelled", cancelledAt: now }).where(and(eq(volunteerTasks.groupId, group.id), eq(volunteerTasks.status, "open")));
    await writeAudit(tx, actor, "volunteer_task.cancel", "volunteer_group", group.id, { by: "organiser", volunteerGroupId: group.id });
  });
  return getVolunteerSheet(db, actor, group.id, now);
}

/** The poster removes any "bringing" line. */
export async function removeBringing(db: Db, actor: Actor, groupId: unknown, bringingId: unknown, now: Date = new Date()): Promise<SheetView> {
  const { group } = await loadGroup(db, actor, groupId);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(volunteerBringing)
      .where(and(eq(volunteerBringing.id, uuidOrNotFound(bringingId)), eq(volunteerBringing.groupId, group.id)))
      .returning({ id: volunteerBringing.id });
    if (row) await writeAudit(tx, actor, "volunteer_bringing.remove", "volunteer_group", group.id, { by: "organiser", volunteerGroupId: group.id });
  });
  return getVolunteerSheet(db, actor, group.id, now);
}

// ─── the board link and the ask-again list ────────────────────────────────────────────

/**
 * Replace the poster's board link: a new token, and the old one is dead at once. Tasks keep their own links.
 */
export async function replaceBoardLink(db: Db, actor: Actor): Promise<{ token: string }> {
  if (!canMakeVolunteerBoard(actor)) deny();
  const existing = await findBoardLink(db, actor);
  if (!existing) return getBoardLink(db, actor);
  const token = newToken();
  await db.transaction(async (tx) => {
    const [row] = await tx.update(volunteerBoards).set({ token, tokenHash: tokenHash(token) }).where(eq(volunteerBoards.ownerUserId, actor.id)).returning({ id: volunteerBoards.id });
    if (row) await writeAudit(tx, actor, "volunteer_board.replace", "volunteer_board", row.id, { by: "organiser" });
  });
  return { token };
}

/**
 * Close the public links of every open task (and shiva sheet) linked to a care item, for someone with full
 * sight of the item: it cancels them, as the poster would. Used when an item has become restricted. Nothing
 * does this automatically. Returns how many tasks were cancelled.
 */
export async function closeLinksForCareItem(db: Db, actor: Actor, careItemId: unknown, now: Date = new Date()): Promise<number> {
  if (!canPostVolunteerTasks(actor)) deny();
  const { item, access } = await loadVisibleCareItemAccess(db, actor, careItemId);
  if (!canLinkVolunteerTaskToCareItem(actor, access)) throw new NotFound();
  return db.transaction(async (tx) => {
    const cancelled = await tx
      .update(volunteerTasks)
      .set({ status: "cancelled", cancelledAt: now })
      .where(and(eq(volunteerTasks.careItemId, item.id), eq(volunteerTasks.status, "open")))
      .returning({ id: volunteerTasks.id, groupId: volunteerTasks.groupId });
    await tx.update(volunteerGroups).set({ cancelledAt: now }).where(and(eq(volunteerGroups.careItemId, item.id), isNull(volunteerGroups.cancelledAt)));
    for (const t of cancelled) await writeAudit(tx, actor, "volunteer_task.close_links", "volunteer_task", t.id, { by: "organiser", volunteerTaskId: t.id, careItemId: item.id });
    return cancelled.length;
  });
}

/** The poster's board link if they have made one; nothing is created by looking. */
export async function findBoardLink(db: Db, actor: Actor): Promise<{ token: string } | null> {
  if (!canMakeVolunteerBoard(actor)) deny();
  const [row] = await db.select({ token: volunteerBoards.token }).from(volunteerBoards).where(eq(volunteerBoards.ownerUserId, actor.id)).limit(1);
  return row ?? null;
}

/** The poster's one board link: made the first time it is asked for, the same afterwards. */
export async function getBoardLink(db: Db, actor: Actor): Promise<{ token: string }> {
  if (!canMakeVolunteerBoard(actor)) deny();
  const find = async () => (await db.select({ token: volunteerBoards.token }).from(volunteerBoards).where(eq(volunteerBoards.ownerUserId, actor.id)).limit(1))[0];
  const existing = await find();
  if (existing) return existing;
  const token = newToken();
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(volunteerBoards).values({ ownerUserId: actor.id, token, tokenHash: tokenHash(token) }).onConflictDoNothing().returning({ id: volunteerBoards.id });
    if (row) await writeAudit(tx, actor, "volunteer_board.create", "volunteer_board", row.id, { by: "organiser" });
  });
  return (await find())!;
}

export type PastHelper = { firstName: string | null; lastName: string | null; contact: string; lastDate: string };

/**
 * Volunteers who ticked "you may ask me again" on a task the actor can see, newest first, once
 * per contact. Never one a poster removed or blocked. Only for those who post tasks; never exported.
 */
export async function listAskAgain(db: Db, actor: Actor): Promise<PastHelper[]> {
  if (!canMakeVolunteerBoard(actor)) deny();
  const rows = await db
    .select({ firstName: volunteerClaims.firstName, lastName: volunteerClaims.lastName, contact: volunteerClaims.contact, key: volunteerClaims.contactKey, date: volunteerTasks.taskDate })
    .from(volunteerClaims)
    .innerJoin(volunteerTasks, eq(volunteerTasks.id, volunteerClaims.taskId))
    .where(
      and(
        volunteerTaskVisibleWhere(actor),
        eq(volunteerClaims.mayAskAgain, true),
        isNotNull(volunteerClaims.contact),
        isNull(volunteerClaims.cancelledAt),
        sql`not exists (select 1 from ${volunteerTaskBlocks} where ${volunteerTaskBlocks.taskId} = ${volunteerClaims.taskId} and ${volunteerTaskBlocks.contactKey} = ${volunteerClaims.contactKey})`,
      ),
    )
    .orderBy(desc(volunteerTasks.taskDate), desc(volunteerClaims.createdAt));
  const seen = new Set<string>();
  const out: PastHelper[] = [];
  for (const r of rows) {
    const k = r.key ?? r.contact!;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ firstName: r.firstName, lastName: r.lastName, contact: r.contact!, lastDate: r.date });
  }
  return out;
}
