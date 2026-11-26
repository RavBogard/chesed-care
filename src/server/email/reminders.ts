/**
 * The day-before reminders, a daily task: helpers who signed up for TOMORROW (Chicago date) by email and whose sign-up
 * still stands. The personal link is stored only as a hash, so the email cannot hold it: it points back to the email
 * sent at sign-up. Sent once (email_log); a re-run sends nothing new. Counts only; no names.
 */
import { and, eq, isNotNull, isNull, like } from "drizzle-orm";
import { reminderMail } from "@/lib/email-wording";
import { mealPages, mealSignups, mealSlots, volunteerClaims, volunteerGroups, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { emailStatus } from "./config";
import { sendEmail, type EmailDeps, type SendResult } from "./send";

/** The task stops starting new sends after this long; the rest are counted as skipped. */
export const REMINDER_BUDGET_MS = 120_000;
/** A reminder that cannot be sent in this long is a failed one. */
export const REMINDER_SEND_TIMEOUT_MS = 5_000;

export async function runHelperReminders(db: Db, now: Date, deps: EmailDeps = {}, budgetMs: number = REMINDER_BUDGET_MS): Promise<Record<string, number>> {
  const tally = { sent: 0, limited: 0, failed: 0, duplicate: 0, notConfigured: 0, skipped: 0 };
  const started = Date.now();
  const sendDeps = { timeoutMs: REMINDER_SEND_TIMEOUT_MS, ...deps, now };
  if (!emailStatus(deps.env).configured) return { ...tally, notConfigured: 1 };
  const tomorrow = addDays(chicagoToday(now), 1);
  const count = (r: SendResult) => {
    if (r === "sent") tally.sent++;
    else if (r === "limited") tally.limited++;
    else if (r === "duplicate") tally.duplicate++;
    else if (r === "failed") tally.failed++;
  };
  const meals = await db
    .select({ id: mealSignups.id, email: mealSignups.email })
    .from(mealSignups)
    .innerJoin(mealSlots, eq(mealSlots.id, mealSignups.slotId))
    .innerJoin(mealPages, eq(mealPages.id, mealSlots.pageId))
    .where(and(eq(mealSlots.date, tomorrow), eq(mealSlots.status, "open"), eq(mealPages.status, "live"), isNull(mealSignups.cancelledAt), isNull(mealSignups.purgedAt), isNotNull(mealSignups.email)));
  const send = async (to: string, what: "meal" | "help", ref: string) => {
    if (Date.now() - started >= budgetMs) {
      tally.skipped++;
      return;
    }
    count(await sendEmail(db, { to, ...reminderMail({ what, date: tomorrow }), kind: what === "meal" ? "reminder_meal" : "reminder_help", ref }, sendDeps));
  };
  for (const m of meals) await send(m.email!, "meal", m.id);
  const claims = await db
    .select({ id: volunteerClaims.id, contact: volunteerClaims.contact })
    .from(volunteerClaims)
    .innerJoin(volunteerTasks, eq(volunteerTasks.id, volunteerClaims.taskId))
    .leftJoin(volunteerGroups, eq(volunteerGroups.id, volunteerTasks.groupId))
    .where(and(eq(volunteerTasks.taskDate, tomorrow), eq(volunteerTasks.status, "open"), isNull(volunteerTasks.cancelledAt), isNull(volunteerGroups.cancelledAt), isNull(volunteerClaims.cancelledAt), isNull(volunteerClaims.doneAt), isNull(volunteerClaims.purgedAt), like(volunteerClaims.contact, "%@%")));
  for (const c of claims) await send(c.contact!, "help", c.id);
  return tally;
}
