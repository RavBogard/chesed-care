/**
 * The daily job's door. Vercel's scheduler calls it with "Authorization: Bearer
 * <CRON_SECRET>"; anything else gets the same 401, with nothing run and nothing
 * said about why. The secret is compared in constant time, and a missing or short
 * secret refuses every call. The answer carries task keys and ok flags only.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "@/server/db/types";
import { runDailyJob, type DailyTask, DAILY_TASKS } from "./run";

/** Shorter than this, the secret is treated as not set. */
export const MIN_SECRET_LENGTH = 16;

export function isScheduledCall(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH || !authorization) return false;
  const given = createHash("sha256").update(authorization).digest();
  const wanted = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(given, wanted);
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const UNAUTHORIZED_BODY = { ok: false } as const;

export async function handleDailyRequest(input: {
  authorization: string | null;
  secret: string | undefined;
  db: () => Db;
  now: Date;
  owners: ReadonlySet<string>;
  origin: string | null;
  tasks?: readonly DailyTask[];
}): Promise<Response> {
  if (!isScheduledCall(input.authorization, input.secret)) return json(UNAUTHORIZED_BODY, 401);
  const results = await runDailyJob({ db: input.db(), now: input.now, owners: input.owners, origin: input.origin }, input.tasks ?? DAILY_TASKS);
  return json({ ok: results.every((r) => r.ok), tasks: results.map((r) => ({ task: r.task, ok: r.ok })) }, 200);
}
