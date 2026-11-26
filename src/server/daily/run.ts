/**
 * The single daily job (about 6:00 America/Chicago; see vercel.json and
 * src/app/api/cron/daily/route.ts). Its tasks run in order, each on its own: one
 * that fails does not stop the others. Each run of each task is a job_runs row:
 * when, ok or the error's NAME only, and counts only. Nothing here logs a name,
 * a note or a token.
 *
 * Daniel, 2026-11-25: "I want it all kept." Nothing here clears or deletes what clergy wrote or
 * were told: care notes, the words of a report, agenda entries and Mitzvah Corps referrals are
 * not on a timer. The clean-ups that remain concern volunteers', helpers' and senders' contact
 * details and operational rows (tokens, counters, logs).
 */
import { and, desc, eq, inArray, isNull, ne, notExists } from "drizzle-orm";
import { canSeeJobRuns, deny, type Actor } from "@/server/access/policy";
import { careItemJourneys, careItems, followUps, jobRuns } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { ensureNextStandingStep } from "@/server/journeys/lifecycle";
import { packetFromEnv, syncMode } from "@/server/misheberach/google";
import { expireDueEntries } from "@/server/misheberach/list";
import type { PacketDoc, SyncMode } from "@/server/misheberach/packet";
import { syncPacket } from "@/server/misheberach/sync";
import { emailSummaryChannel } from "@/server/email/summary-channel";
import { runHelperReminders } from "@/server/email/reminders";
import { purgeEmailLog } from "@/server/email/send";
import { purgeMealData } from "@/server/meals/purge";
import { purgeVolunteerData } from "@/server/volunteers/purge";
import { rosterUpkeep } from "@/server/volunteers/roster";
import { lapseReferrals } from "@/server/volunteers/referrals";
import { purgeVisiting } from "@/server/volunteers/visiting";
import { countStaleReporters, pruneRateLimits, purgeOldDismissals, revokeIdleCaptureTokens } from "./housekeeping";
import { purgeReporters } from "@/server/care/reporter";
import { flushHeld, noticeCoveringTomorrow, noticeUnfilledAsks, purgeNotificationLog } from "@/server/notify/notify";
import { pushSummaryChannel } from "@/server/notify/summary-channel";
import { purgeRevoked } from "@/server/notify/subscriptions";
import { NOT_CONFIGURED, runMorningSummaries } from "./summary";

export type DailyContext = { db: Db; now: Date; owners: ReadonlySet<string>; origin: string | null; channels?: typeof NOT_CONFIGURED; /** The bima packet; tests pass a fake. Left out, it is made from the environment (null when not configured). */ packet?: PacketDoc | null; /** With a fake `packet`, tests may pick the mode; otherwise "on" for a fake and the environment's for the real one. */ packetMode?: SyncMode };
export type Counts = Record<string, number>;
export type DailyTask = { key: string; run: (ctx: DailyContext) => Promise<Counts> };

/** Standing check-ins whose last step is done and no next one exists: a safety net, as the next is normally made when the last is done. */
async function standingSafetyNet(ctx: DailyContext): Promise<Counts> {
  const openStep = ctx.db
    .select({ id: followUps.id })
    .from(followUps)
    .where(and(eq(followUps.journeyId, careItemJourneys.id), isNull(followUps.doneAt)));
  const runs = await ctx.db
    .select({ id: careItemJourneys.id })
    .from(careItemJourneys)
    .innerJoin(careItems, eq(careItems.id, careItemJourneys.careItemId))
    .where(and(eq(careItemJourneys.templateKey, "standing"), isNull(careItemJourneys.endedAt), ne(careItems.status, "closed"), notExists(openStep)));
  let made = 0;
  for (const { id } of runs) if (await ensureNextStandingStep(ctx.db, id, ctx.now)) made++;
  return { checked: runs.length, made };
}

/** The packet sync as a daily task: a run that stopped is a failed task, by the error's name only. */
async function packetSync(ctx: DailyContext): Promise<Counts> {
  const doc = ctx.packet !== undefined ? ctx.packet : packetFromEnv();
  const mode = ctx.packetMode ?? (ctx.packet !== undefined ? "on" : syncMode());
  const result = await syncPacket(ctx.db, doc, ctx.now, null, { mode });
  if (result.status === "failed") throw Object.assign(new Error("Packet sync failed"), { name: result.errorName });
  return result.status === "ok" ? result.counts : { connected: result.status === "busy" ? 1 : 0, busy: result.status === "busy" ? 1 : 0 };
}

export const DAILY_TASKS: readonly DailyTask[] = [
  { key: "meal_purge", run: async ({ db, now }) => purgeMealData(db, now) },
  { key: "volunteer_purge", run: async ({ db, now }) => purgeVolunteerData(db, now) },
  { key: "roster_upkeep", run: async ({ db, now }) => rosterUpkeep(db, now) },
  { key: "visiting_purge", run: async ({ db, now }) => purgeVisiting(db, now) },
  { key: "corps_referral_lapse", run: async ({ db, now }) => lapseReferrals(db, now) },
  { key: "mi_sheberach_expiry", run: async ({ db, now }) => expireDueEntries(db, now) },
  { key: "mi_sheberach_sync", run: packetSync },
  { key: "standing_check_ins", run: standingSafetyNet },
  {
    key: "housekeeping",
    run: async ({ db, now }) => ({ tokensRevoked: await revokeIdleCaptureTokens(db, now), rateLimitRowsDeleted: await pruneRateLimits(db, now), staleReporters: await countStaleReporters(db, now), suggestionsPurged: await purgeOldDismissals(db, now).catch(() => 0), emailLogDeleted: await purgeEmailLog(db, now).catch(() => 0) }),
  },
  { key: "clergy_upkeep", run: async ({ db, now }) => ({ reportersCleared: (await purgeReporters(db, now)).cleared }) },
  { key: "cover_notice", run: async ({ db, now, owners }) => ({ sent: await noticeCoveringTomorrow(db, now, owners) }) },
  { key: "volunteer_asks_notice", run: async ({ db, now, owners }) => ({ ...(await noticeUnfilledAsks(db, now, owners)) }) },
  {
    key: "push_upkeep",
    run: async ({ db, now, owners }) => {
      const held = await flushHeld(db, now, owners);
      return { revokedDeleted: await purgeRevoked(db, now), logDeleted: await purgeNotificationLog(db, now), heldStale: held.stale, heldSent: held.sent, heldWaiting: held.waiting };
    },
  },
  { key: "morning_summary", run: async ({ db, now, owners, origin, channels }) => runMorningSummaries(db, now, owners, origin, channels ?? { email: emailSummaryChannel(db, now), push: pushSummaryChannel(db, now, owners) }) },
  // Last: it may take a while, and it stops by itself after its time budget.
  { key: "helper_reminders", run: async ({ db, now }) => runHelperReminders(db, now) },
];

export type TaskResult = { task: string; ok: boolean; errorName: string | null; counts: Counts | null };

export async function runDailyJob(ctx: DailyContext, tasks: readonly DailyTask[] = DAILY_TASKS): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    const rowId = await record("start", () => ctx.db.insert(jobRuns).values({ task: task.key, startedAt: new Date() }).returning({ id: jobRuns.id }).then(([r]) => r.id));
    let result: TaskResult;
    try {
      const counts = await task.run(ctx);
      result = { task: task.key, ok: true, errorName: null, counts };
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "unknown";
      // A fixed label, the task's fixed key and the error's name: never its message, which could quote data.
      console.error("Daily job task failed", task.key, errorName);
      result = { task: task.key, ok: false, errorName, counts: null };
    }
    if (rowId) await record("finish", () => ctx.db.update(jobRuns).set({ finishedAt: new Date(), ok: result.ok, errorName: result.errorName, counts: result.counts }).where(eq(jobRuns.id, rowId)).then(() => rowId));
    results.push(result);
  }
  return results;
}

/** A write to job_runs. A recorder that fails is logged by name and skipped: it never stops the tasks that follow. */
async function record(step: "start" | "finish", write: () => Promise<string>): Promise<string | null> {
  try {
    return await write();
  } catch (error) {
    console.error("Daily job record failed", step, error instanceof Error ? error.name : "unknown");
    return null;
  }
}

export type JobRunView = { task: string; startedAt: Date; finishedAt: Date | null; ok: boolean | null; errorName: string | null; counts: Counts | null };

/** The daily job is overdue when its last successful run is older than this: a day plus two hours of slack. */
export const JOB_STALE_HOURS = 26;

/** Whether the last successful run is missing or too old, for the plain warning in Settings. Pure. */
export function jobIsOverdue(runs: Pick<JobRunView, "ok" | "startedAt" | "finishedAt">[], now: Date): boolean {
  const times = runs.filter((r) => r.ok === true).map((r) => (r.finishedAt ?? r.startedAt).getTime());
  return times.length === 0 || now.getTime() - Math.max(...times) > JOB_STALE_HOURS * 3_600_000;
}

/** The latest run of each task, for the owner's "Daily job" block. */
export async function latestJobRuns(db: Db, actor: Actor): Promise<JobRunView[]> {
  if (!canSeeJobRuns(actor)) deny();
  const keys = DAILY_TASKS.map((t) => t.key);
  const rows = await db
    .selectDistinctOn([jobRuns.task])
    .from(jobRuns)
    .where(inArray(jobRuns.task, keys))
    .orderBy(jobRuns.task, desc(jobRuns.startedAt));
  const byKey = new Map(rows.map((r) => [r.task, r]));
  return keys.flatMap((k) => {
    const r = byKey.get(k);
    return r ? [{ task: r.task, startedAt: r.startedAt, finishedAt: r.finishedAt, ok: r.ok, errorName: r.errorName, counts: (r.counts as Counts | null) ?? null }] : [];
  });
}
