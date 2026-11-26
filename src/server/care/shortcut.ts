/**
 * POST /api/capture: the iPhone Shortcut. One request, one proposal, made as the person
 * the bearer token belongs to, on the "shortcut" channel and with the same scope rules
 * as that person's own in-app capture. The answer is `{ ok: true }` and nothing about
 * people. Any bad token (malformed, unknown, revoked, owner deactivated or removed)
 * gets the same 401. Neither the token nor the text is ever logged.
 */
import { resolveActor } from "@/server/access/actor";
import { canUseCaptureTokens } from "@/server/access/policy";
import type { Db } from "@/server/db/types";
import { readClient, withinLimit } from "@/server/meals/rate-limit";
import { resolveCaptureToken, touchCaptureToken } from "./capture-tokens";
import { scheduleReading } from "./ai-reading";
import { createProposal } from "./proposals";
import { InvalidInput } from "./validate";

export const CAPTURE_LIMITS = {
  /** Requests from one client per clock hour, good or bad. */
  perClient: 120,
  /** Requests with a bad token from one client per clock hour. */
  badPerClient: 10,
  /** Captures per token per clock hour. */
  perToken: 30,
} as const;

export const CAPTURE_BODY_MAX = 16 * 1024;

export type CaptureReply = { status: 200 | 400 | 401 | 403 | 429; body: { ok: boolean } };
const reply = (status: CaptureReply["status"], ok = false): CaptureReply => ({ status, body: { ok } });

/** The text of a request: `{ "text": "..." }` as JSON, or the body itself as text/plain. Null when there is none. */
export function textOf(contentType: string | null, raw: string): string | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json") {
    try {
      const body: unknown = JSON.parse(raw);
      const t = body && typeof body === "object" ? (body as Record<string, unknown>).text : undefined;
      return typeof t === "string" ? t : null;
    } catch {
      return null;
    }
  }
  return type === "text/plain" ? raw : null;
}

export async function handleCapture(input: { db: Db; authorization: string | null; contentType: string | null; raw: string; clientKey: string | null; owners: ReadonlySet<string>; now?: Date }): Promise<CaptureReply> {
  const { db } = input;
  const now = input.now ?? new Date();
  const client = input.clientKey ? readClient({ clientKey: input.clientKey }, now, false) : null;
  // No address the platform vouches for: refused before anything else is read.
  if (!client) return reply(403);
  if (!(await withinLimit(db, `capture:client:${client.hash}`, CAPTURE_LIMITS.perClient, now))) return reply(429);

  const presented = /^Bearer (\S+)$/.exec(input.authorization ?? "")?.[1] ?? "";
  const found = await resolveCaptureToken(db, presented);
  // The owner is re-read from the allowlist on every use.
  const actor = found ? await resolveActor(db, { email: found.email, name: found.name }, input.owners) : null;
  if (!found || !actor || !canUseCaptureTokens(actor)) {
    // Bad tokens have a bucket of their own: running it dry slows only more bad tokens, never a valid one from the same address.
    return (await withinLimit(db, `capture:bad:${client.hash}`, CAPTURE_LIMITS.badPerClient, now)) ? reply(401) : reply(429);
  }
  await touchCaptureToken(db, found.tokenId, now);
  if (!(await withinLimit(db, `capture:token:${found.tokenId}`, CAPTURE_LIMITS.perToken, now))) return reply(429);

  const text = textOf(input.contentType, input.raw);
  if (!text?.trim()) return reply(400);
  try {
    const made = await createProposal(db, actor, { rawText: text, channel: "shortcut", reviewScope: "submitter" });
    scheduleReading(db, made.id);
  } catch (error) {
    if (error instanceof InvalidInput) return reply(400);
    throw error;
  }
  return reply(200, true);
}
