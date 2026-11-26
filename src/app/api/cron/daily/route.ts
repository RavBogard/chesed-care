import { handleDailyRequest } from "@/server/daily/request";
import { getDb } from "@/server/db/client";
import { appOrigin, ownerEmails } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function origin(): string | null {
  try {
    return appOrigin();
  } catch {
    return null;
  }
}

/**
 * The single daily job, called by Vercel's scheduler (vercel.json "schedules", about
 * 6:00 America/Chicago) with the CRON_SECRET bearer, and by nothing else: no cookie,
 * no viewer. It never runs from the build. See src/server/daily.
 */
async function daily(request: Request): Promise<Response> {
  try {
    return await handleDailyRequest({ authorization: request.headers.get("authorization"), secret: process.env.CRON_SECRET, db: getDb, now: new Date(), owners: ownerEmails(), origin: origin() });
  } catch (error) {
    console.error("Daily job failed", error instanceof Error ? error.name : "unknown");
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
}

/** The schedule calls with POST (vercel.json requestMethod); nothing else is exported. */
export const POST = daily;
