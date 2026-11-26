/**
 * The morning summary's phone channel: it plugs into deliverSummary (src/server/daily/summary.ts), which has
 * already built the counts-only message with summaryMessage and decided the person chose a phone notice.
 * Only the total count goes on to the fixed template; the message's own words are not used by the phone.
 */
import type { Channel } from "@/server/daily/summary";
import { isEmptySummary } from "@/server/daily/summary";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { deliverNotice, loadRecipients, type Owners } from "./notify";
import { pushStatus } from "./config";

export function pushSummaryChannel(db: Db, now: Date, owners: Owners): Channel {
  return async (userId, _message, summary) => {
    if (!pushStatus().configured) return "not_configured";
    if (isEmptySummary(summary)) return "not_chosen";
    const actor = (await loadRecipients(db, owners)).find((a) => a.id === userId);
    if (!actor) return "not_chosen";
    const total = summary.overdue + summary.dueToday + summary.inbox + summary.newSteps;
    const outcome = await deliverNotice(db, actor, { kind: "morning_summary", count: total }, { now, dedupeKey: chicagoToday(now), fromJob: true });
    // "not_chosen": held for quiet hours, switched off, or no device to send to; "not_configured" is only for missing keys.
    return outcome === "sent" ? "sent" : outcome === "not_configured" ? "not_configured" : "not_chosen";
  };
}
