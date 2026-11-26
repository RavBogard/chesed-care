import { createHash, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3000;
const TOKEN_HEADER = "x-health-token";

type DbState = "reachable" | "unreachable" | "not_configured" | "not_checked";

async function databaseState(): Promise<DbState> {
  const url = process.env.DATABASE_URL;
  if (!url) return "not_configured";
  try {
    const sql = neon(url);
    const ping = sql`select 1 as ok`.then(() => "reachable" as const);
    const timeout = new Promise<DbState>((resolve) => setTimeout(() => resolve("unreachable"), DB_TIMEOUT_MS));
    return await Promise.race([ping, timeout]);
  } catch {
    return "unreachable";
  }
}

/** Constant-time comparison of the request's token with HEALTH_TOKEN (unset = never matches). */
function hasHealthToken(request: Request): boolean {
  const expected = process.env.HEALTH_TOKEN;
  const given = request.headers.get(TOKEN_HEADER);
  if (!expected || !given) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Liveness that never depends on the database: always answers 200 with the app's
 * own status. The database is usage-billed, so it is pinged only for a caller that
 * sends the HEALTH_TOKEN secret in the x-health-token header; everyone else gets
 * database "not_checked" and the database stays asleep.
 */
export async function GET(request: Request) {
  const database = hasHealthToken(request) ? await databaseState() : "not_checked";
  return Response.json({ ok: true, service: "crc-care", time: new Date().toISOString(), database }, { headers: { "Cache-Control": "no-store" } });
}
