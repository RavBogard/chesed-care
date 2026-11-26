/**
 * The morning summary's email channel: it plugs into deliverSummary (src/server/daily/summary.ts), which has already built the
 * counts-only message and decided the person chose email. The address is looked up here by the person's id, and goes no further.
 */
import { eq } from "drizzle-orm";
import { morningSummaryMail } from "@/lib/email-wording";
import type { Channel } from "@/server/daily/summary";
import { users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { emailStatus } from "./config";
import { sendEmail, type EmailDeps } from "./send";

export function emailSummaryChannel(db: Db, now: Date, deps: EmailDeps = {}): Channel {
  return async (userId, message) => {
    if (!emailStatus(deps.env).configured) return "not_configured";
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.email) return "not_chosen";
    const mail = morningSummaryMail(message.body);
    const result = await sendEmail(db, { to: user.email, ...mail, kind: "morning_summary", ref: `${userId}:${chicagoToday(now)}` }, { ...deps, now });
    return result === "sent" ? "sent" : result === "not_configured" ? "not_configured" : "not_chosen";
  };
}
