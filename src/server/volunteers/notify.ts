/**
 * Asking the roster by email, from the app. Each member who has an address gets their own email (never a BCC), with the
 * app's own ask words and a signed link that stops these emails (stop-link.ts). Members without an address are counted, not
 * emailed. Text messages are not sent by the app: that channel still says it is not configured.
 */
import { askMail } from "@/lib/email-wording";
import type { Db } from "@/server/db/types";
import { emailStatus } from "@/server/email/config";
import { sendEmail, type EmailDeps } from "@/server/email/send";
import { signedStopPath } from "./stop-link";

export type NotifyMember = { id: string; email?: string | null };
export type NotifyChannel = "email" | "sms";
export type NotifyResult =
  | { status: "not_configured"; sent: 0; channel: NotifyChannel }
  | { status: "done"; channel: "email"; sent: number; noEmail: number; notSent: number; /** Who was actually emailed. */ sentIds: string[] };

/** What sending by email needs besides the members: the database, the app's address, what the ask is about (an id) and the day. */
export type EmailAskContext = { db: Db; origin: string; ref: string; deps?: EmailDeps };

/** At most this many people per press. */
export const EMAIL_ASK_MAX = 60;

export async function notifyMembers(members: NotifyMember[], message: { subject: string; body: string }, channel: NotifyChannel = "email", ctx?: EmailAskContext): Promise<NotifyResult> {
  if (channel !== "email" || !ctx || !emailStatus(ctx.deps?.env).configured) return { status: "not_configured", sent: 0, channel };
  const sentIds: string[] = [];
  let noEmail = 0;
  let notSent = 0;
  for (const m of members.slice(0, EMAIL_ASK_MAX)) {
    if (!m.email) {
      noEmail++;
      continue;
    }
    const mail = askMail({ askText: message.body, stopUrl: `${ctx.origin}${signedStopPath(m.id)}` });
    const stopUrl = `${ctx.origin}${signedStopPath(m.id)}`;
    const result = await sendEmail(ctx.db, { to: m.email, subject: message.subject, text: mail.text, kind: "roster_ask", ref: ctx.ref, headers: { "List-Unsubscribe": `<${stopUrl}>` } }, ctx.deps);
    if (result === "sent") sentIds.push(m.id);
    else notSent++;
  }
  return { status: "done", channel: "email", sent: sentIds.length, noEmail, notSent, sentIds };
}
