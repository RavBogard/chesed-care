/**
 * What the poster's, the public and the purge sides of volunteer tasks share: the
 * row types, how many places are left and when a link stops working. Nothing here
 * decides access; callers have already checked an actor or a token.
 */
import { and, inArray, isNull, sql } from "drizzle-orm";
import { volunteerClaims, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays } from "@/server/lifecycle/window";

export { CONGREGATION } from "@/server/meals/core";

export type Task = typeof volunteerTasks.$inferSelect;
export type Claim = typeof volunteerClaims.$inferSelect;

/** A link works for viewing through the day after the date; it takes claims only until the date has passed. */
export const lastViewDay = (task: Pick<Task, "taskDate">) => addDays(task.taskDate, 1);

/** Open, and not yet past the day after its date. Anything else looks, to a stranger, like a link that never was. */
export function isLive(task: Pick<Task, "status" | "taskDate">, today: string): boolean {
  return task.status === "open" && today <= lastViewDay(task);
}

/** The date has gone by (one more day of viewing remains). */
export const isPast = (task: Pick<Task, "taskDate">, today: string) => task.taskDate < today;

/** People who currently hold a place on each task: claims not cancelled. */
export async function activeCounts(db: Db, taskIds: string[]): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({ taskId: volunteerClaims.taskId, n: sql<number>`count(*)::int` })
    .from(volunteerClaims)
    .where(and(inArray(volunteerClaims.taskId, taskIds), isNull(volunteerClaims.cancelledAt)))
    .groupBy(volunteerClaims.taskId);
  return new Map(rows.map((r) => [r.taskId, r.n]));
}

export const placesLeft = (task: Pick<Task, "peopleNeeded">, taken: number) => Math.max(0, task.peopleNeeded - taken);

/** What a claimant is given once, and again on their personal page while the claim stands. */
export type ClaimDetails = { kind: Task["kind"]; forLabel: string; needed: string; date: string; timeWindow: string | null; place: string | null; contactLine: string | null };

export const detailsOf = (t: Task): ClaimDetails => ({ kind: t.kind, forLabel: t.forLabel, needed: t.needed, date: t.taskDate, timeWindow: t.timeWindow, place: t.place, contactLine: t.contactLine });
