/**
 * The one way the app sends email: plain text through Resend's REST API (no package, no HTML, no tracking). It never
 * throws to its caller, never logs an address or a body (a failure logs the kind and the HTTP status only), and keeps
 * only a keyed hash of the address. Callers pass the words (src/lib/email-wording.ts); nothing here writes any.
 *
 * Caps: 6 emails per recipient per day, 300 per hour and 1500 per day in all. The same (kind, ref, recipient) is sent
 * once: a second send answers "duplicate". A send that fails is forgotten, so a later run may try again.
 *
 * Held: a Mitzvah Corps member brought in from the old spreadsheet and not yet asked (emails_held) gets no mail the
 * roster starts (an ask, a welcome, anything new) until the owner turns it on: it answers "held" and nothing is logged.
 * What they asked for themselves by signing up (a confirmation, a day-before reminder) still goes. After the owner turns
 * it on, their first email carries a sentence saying what this is and their stop link. See ./roster-gate.ts.
 */
import { eq, lt } from "drizzle-orm";
import { importedIntro } from "@/lib/email-wording";
import { safeEmails } from "@/lib/ask-links";
import { runAfterResponse } from "@/server/after";
import { emailLog } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { signFor } from "@/server/meals/client-meta";
import { withinDailyLimit, withinLimit } from "@/server/meals/rate-limit";
import { signedStopPath } from "@/server/volunteers/stop-link";
import { emailStatus } from "./config";
import { claimIntro, giveBackIntro, rosterGate } from "./roster-gate";

export { ACCOUNT_KINDS, SELF_REQUESTED_KINDS } from "./roster-gate";

export const FROM = "Central Reform Congregation <care@centralreform.org>";
export const DEFAULT_REPLY_TO = "care@centralreform.org";
export const EMAIL_LIMITS = { perRecipientPerDay: 6, perHour: 300, perDay: 1500, publicPerHour: 120, publicPerDay: 400 } as const;
/** Kinds an anonymous person can trigger. They also count against a lower shared cap, so a flood of them cannot use up the budget staff email needs. */
export const PUBLIC_KINDS: readonly string[] = ["meal_signup", "volunteer_signup", "join_welcome"];
const TIMEOUT_MS = 10_000;
const KEEP_DAYS = 60;

/** The one extra header allowed: where a human can stop these emails (a URL in angle brackets, no line breaks). */
export type EmailHeaders = { "List-Unsubscribe"?: string };
export type EmailMessage = { to: string; subject: string; text: string; kind: string; ref: string; headers?: EmailHeaders };
export type SendResult = "sent" | "not_configured" | "limited" | "duplicate" | "failed" | "held";
export type EmailDeps = { fetch?: typeof fetch; now?: Date; env?: Record<string, string | undefined>; timeoutMs?: number };

/** The headers to send, or null when anything but the one allowed header, or an unsafe value, was passed. */
export function safeHeaders(headers: unknown): EmailHeaders | null {
  if (headers === undefined) return {};
  if (typeof headers !== "object" || headers === null) return null;
  const entries = Object.entries(headers);
  if (entries.some(([k]) => k !== "List-Unsubscribe")) return null;
  const value = (headers as EmailHeaders)["List-Unsubscribe"];
  if (value === undefined) return {};
  return typeof value === "string" && value.length <= 500 && /^<https:\/\/[^\s<>]+>$/.test(value) ? { "List-Unsubscribe": value } : null;
}

/** A keyed hash of the lower-cased address: what the log and the limits remember instead of the address. */
export function addressHash(address: string): string {
  return signFor("email-address", address.toLowerCase());
}

/** The address as one plain lower-case address, or null: no spaces, commas, angle brackets or line breaks. */
export function strictAddress(to: unknown): string | null {
  if (typeof to !== "string" || to.length > 254 || to !== to.trim()) return null;
  const [one] = safeEmails([to]);
  return one !== undefined && one === to.toLowerCase() ? one : null;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();


export async function sendEmail(db: Db, message: EmailMessage, deps: EmailDeps = {}): Promise<SendResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  let claimed: string | null = null;
  let introTaken: string | null = null;
  try {
    const to = strictAddress(message.to);
    if (!to) return "failed";
    const extra = safeHeaders(message.headers);
    if (!extra) return "failed";
    if (!emailStatus(env).configured) return "not_configured";
    const gate = await rosterGate(db, to, message.kind);
    if (gate.held) return "held";
    // An intro is never sent without its stop link: no address for the app, no email.
    const base = env.BETTER_AUTH_URL?.trim() || process.env.BETTER_AUTH_URL?.trim();
    if (gate.introFor && !base) return "failed";
    const hash = addressHash(to);
    const [row] = await db.insert(emailLog).values({ kind: message.kind, ref: message.ref, toHash: hash }).onConflictDoNothing().returning({ id: emailLog.id });
    if (!row) return "duplicate";
    claimed = row.id;
    const isPublic = PUBLIC_KINDS.includes(message.kind);
    const within =
      (!isPublic || ((await withinLimit(db, "email:public", EMAIL_LIMITS.publicPerHour, now)) && (await withinDailyLimit(db, "day:email:public", EMAIL_LIMITS.publicPerDay, now)))) &&
      (await withinDailyLimit(db, `day:email:to:${hash}`, EMAIL_LIMITS.perRecipientPerDay, now)) &&
      (await withinLimit(db, "email:all", EMAIL_LIMITS.perHour, now)) &&
      (await withinDailyLimit(db, "day:email:all", EMAIL_LIMITS.perDay, now));
    if (!within) {
      await forget(db, claimed);
      return "limited";
    }
    let text = message.text;
    if (gate.introFor && (await claimIntro(db, gate.introFor))) {
      introTaken = gate.introFor;
      const stopUrl = `${new URL(base!).origin}${signedStopPath(introTaken)}`;
      text = `${importedIntro(stopUrl)}\n\n${text}`;
      extra["List-Unsubscribe"] ??= `<${stopUrl}>`;
    }
    const replyTo = strictAddress(env.CARE_REPLY_TO?.trim()) ?? DEFAULT_REPLY_TO;
    const response = await (deps.fetch ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject: oneLine(message.subject), text, reply_to: replyTo, ...(extra["List-Unsubscribe"] ? { headers: extra } : {}) }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("email.failed", message.kind, response.status);
      await forget(db, claimed);
      if (introTaken) await giveBackIntro(db, introTaken);
      return "failed";
    }
    await db.update(emailLog).set({ ok: true }).where(eq(emailLog.id, claimed));
    return "sent";
  } catch (error) {
    console.error("email.failed", message.kind, error instanceof Error ? error.name : "unknown");
    if (claimed) await forget(db, claimed).catch(() => undefined);
    if (introTaken) await giveBackIntro(db, introTaken).catch(() => undefined);
    return "failed";
  }
}

async function forget(db: Db, id: string): Promise<void> {
  await db.delete(emailLog).where(eq(emailLog.id, id));
}

/** Daily: log rows older than 60 days. Counts only. */
export async function purgeEmailLog(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(emailLog)
    .where(lt(emailLog.createdAt, new Date(now.getTime() - KEEP_DAYS * 86_400_000)))
    .returning({ id: emailLog.id });
  return gone.length;
}

/**
 * Run `task` after the response is sent, so a redirect is not delayed. Does nothing when email is not set up. A
 * failure logs a fixed label and the error's class. Outside a request (a script or a test) nothing is scheduled.
 */
export function afterEmail(task: () => Promise<unknown>): void {
  if (!emailStatus().configured) return;
  runAfterResponse("email.task_failed", task);
}
