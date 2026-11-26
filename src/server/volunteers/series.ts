/**
 * Repeating volunteer tasks, the poster's side. A series is a group id over ordinary tasks, each with its own
 * link, claimable on its own. Creating makes every occurrence at once (never more than 26). Editing and cancelling
 * touch occurrences from today on that nobody has claimed, and touch claimed ones only when the poster says so
 * (the first answer says how many are claimed, so the screen can ask). The words are the poster's, exactly as for
 * a single task: nothing from a care record.
 */
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { canPostVolunteerTasks, deny, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { InvalidInput } from "@/server/care/validate";
import { volunteerSeries, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { daysBetween } from "@/lib/format";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { newToken, tokenHash } from "@/server/meals/tokens";
import { activeCounts } from "./core";
import { createTaskInput, MINYAN, parse, taskPatch } from "./input";
import { careItemFor, getVolunteerTask, loadTask, type TaskView } from "./organiser";

export const MAX_OCCURRENCES = 26;

export const createSeriesInput = createTaskInput
  .extend({
    every: z.union([z.literal(1), z.literal(2)]),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .transform((v) => [...new Set(v)].sort()),
    until: z.string().optional(),
    count: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
  })
  .refine((v) => (v.until === undefined) !== (v.count === undefined), { path: ["count"] });

const seriesPatch = taskPatch.pick({ forLabel: true, needed: true, timeWindow: true, place: true, contactLine: true });

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The furthest a series may reach: 26 occurrences every second week is a year, and a little over gives an end date room. */
const HORIZON_DAYS = 380;

/**
 * PURE. The dates of a repeating task: from `start`, on the chosen weekdays (0 is Sunday), in every week or every
 * second week (weeks run Sunday to Saturday, counted from the week of `start`), until a date or for `count` times.
 * More than 26 is refused, never trimmed.
 */
export function occurrenceDates(rule: { start: string; every: 1 | 2; weekdays: number[]; until?: string; count?: number }): string[] {
  if (rule.until !== undefined && rule.until > addDays(rule.start, HORIZON_DAYS)) throw new InvalidInput("until");
  const weekStart = addDays(rule.start, -weekday(rule.start));
  const out: string[] = [];
  const limit = addDays(rule.start, HORIZON_DAYS);
  for (let d = rule.start; d <= limit; d = addDays(d, 1)) {
    if (rule.until !== undefined && d > rule.until) break;
    if (Math.floor(daysBetween(weekStart, d) / 7) % rule.every === 0 && rule.weekdays.includes(weekday(d))) {
      out.push(d);
      if (rule.count !== undefined && out.length === rule.count) break;
      if (out.length > MAX_OCCURRENCES) throw new InvalidInput("until");
    }
  }
  if (out.length === 0) throw new InvalidInput("weekdays");
  return out;
}

/** Post a repeating task. Every occurrence is open at once with its own link. Returns the first one. */
export async function createVolunteerSeries(db: Db, actor: Actor, input: unknown, now: Date = new Date()): Promise<{ seriesId: string; taskIds: string[]; first: TaskView }> {
  if (!canPostVolunteerTasks(actor)) deny();
  const { careItemId, date, peopleNeeded, every, weekdays, until, count, ...fields } = parse(createSeriesInput, input);
  if (date < chicagoToday(now)) throw new InvalidInput("date");
  if (until !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < date)) throw new InvalidInput("until");
  const dates = occurrenceDates({ start: date, every, weekdays, until, count });
  const linked = await careItemFor(db, actor, careItemId);
  const created = await db.transaction(async (tx) => {
    const [series] = await tx.insert(volunteerSeries).values({ createdBy: actor.id }).returning({ id: volunteerSeries.id });
    const rows = await tx
      .insert(volunteerTasks)
      .values(
        dates.map((taskDate) => {
          const publicToken = newToken();
          return {
            seriesId: series.id,
            kind: fields.kind,
            forLabel: fields.forLabel,
            needed: fields.needed,
            timeWindow: fields.timeWindow ?? null,
            place: fields.place ?? null,
            contactLine: fields.contactLine ?? null,
            taskDate,
            peopleNeeded: peopleNeeded ?? (fields.kind === "shiva_minyan" ? MINYAN : 1),
            careItemId: linked,
            publicToken,
            publicTokenHash: tokenHash(publicToken),
            createdBy: actor.id,
          };
        }),
      )
      .returning({ id: volunteerTasks.id, taskDate: volunteerTasks.taskDate });
    await writeAudit(tx, actor, "volunteer_series.create", "volunteer_series", series.id, { by: "organiser", volunteerSeriesId: series.id, count: rows.length, careItemId: linked });
    return { seriesId: series.id, ids: rows.sort((a, b) => a.taskDate.localeCompare(b.taskDate)).map((r) => r.id) };
  });
  return { seriesId: created.seriesId, taskIds: created.ids, first: await getVolunteerTask(db, actor, created.ids[0], now) };
}

/** The open occurrences from today on, split into those nobody holds and those someone does. */
async function reachable(db: Db, seriesId: string, today: string) {
  const rows = await db
    .select({ id: volunteerTasks.id })
    .from(volunteerTasks)
    .where(and(eq(volunteerTasks.seriesId, seriesId), eq(volunteerTasks.status, "open"), gte(volunteerTasks.taskDate, today)))
    .orderBy(asc(volunteerTasks.taskDate));
  const held = await activeCounts(db, rows.map((r) => r.id));
  return { free: rows.filter((r) => !held.get(r.id)).map((r) => r.id), claimed: rows.filter((r) => held.get(r.id)).map((r) => r.id) };
}

export type SeriesChange = { changed: number; claimedLeft: number };

/**
 * Change the words or time of this task's series for every occurrence from today on that nobody has claimed. Those
 * with a volunteer are changed only when `includeClaimed` is true (their pages then show the new words); otherwise
 * how many were left is returned, so the screen can ask.
 */
export async function updateVolunteerSeries(db: Db, actor: Actor, taskId: unknown, patch: unknown, includeClaimed: boolean, now: Date = new Date()): Promise<SeriesChange> {
  const { task } = await loadTask(db, actor, taskId);
  if (!task.seriesId) throw new InvalidInput("series");
  const set = parse(seriesPatch, patch);
  if (Object.keys(set).length === 0) throw new InvalidInput("input");
  const { free, claimed } = await reachable(db, task.seriesId, chicagoToday(now));
  const ids = includeClaimed ? [...free, ...claimed] : free;
  if (ids.length)
    await db.transaction(async (tx) => {
      await tx.update(volunteerTasks).set(set).where(inArray(volunteerTasks.id, ids));
      await writeAudit(tx, actor, "volunteer_series.update", "volunteer_series", task.seriesId!, { by: "organiser", volunteerSeriesId: task.seriesId!, count: ids.length });
    });
  return { changed: ids.length, claimedLeft: includeClaimed ? 0 : claimed.length };
}

/** Cancel the unclaimed occurrences from today on; claimed ones too only when `includeClaimed` is true. */
export async function cancelVolunteerSeries(db: Db, actor: Actor, taskId: unknown, includeClaimed: boolean, now: Date = new Date()): Promise<SeriesChange> {
  const { task } = await loadTask(db, actor, taskId);
  if (!task.seriesId) throw new InvalidInput("series");
  const { free, claimed } = await reachable(db, task.seriesId, chicagoToday(now));
  const ids = includeClaimed ? [...free, ...claimed] : free;
  if (ids.length)
    await db.transaction(async (tx) => {
      await tx.update(volunteerTasks).set({ status: "cancelled", cancelledAt: now }).where(and(inArray(volunteerTasks.id, ids), eq(volunteerTasks.status, "open")));
      await writeAudit(tx, actor, "volunteer_series.cancel", "volunteer_series", task.seriesId!, { by: "organiser", volunteerSeriesId: task.seriesId!, count: ids.length });
    });
  return { changed: ids.length, claimedLeft: includeClaimed ? 0 : claimed.length };
}

/** The series' occurrences for the poster: dates and how many places are taken. */
export async function listSeriesOccurrences(db: Db, actor: Actor, taskId: unknown): Promise<{ id: string; date: string; status: string; taken: number; peopleNeeded: number }[]> {
  const { task } = await loadTask(db, actor, taskId);
  if (!task.seriesId) return [];
  const rows = await db.select().from(volunteerTasks).where(eq(volunteerTasks.seriesId, task.seriesId)).orderBy(asc(volunteerTasks.taskDate));
  const counts = await activeCounts(db, rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, date: r.taskDate, status: r.status, taken: counts.get(r.id) ?? 0, peopleNeeded: r.peopleNeeded }));
}
