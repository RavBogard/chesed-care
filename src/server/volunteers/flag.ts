/**
 * "Something a rabbi should know": a volunteer, from their own page (personal link, no account), tells the rabbis
 * about a bigger need they found. It becomes an ordinary proposal in the clergy Inbox, like any arrival through a
 * public link: no submitter, review scope clergy, never practical (so the Mitzvah Corps lead never sees it).
 *
 * Daniel, 2026-11-25: "When anyone writes, nothing should be refused." So the words are refused only when empty, too
 * long, or holding the control and invisible characters the house refuses everywhere; never for what they say.
 *
 * The words go ONLY to the proposal. The claim keeps the time it was sent (`flagged_at`), so the poster and the
 * coordinator see THAT something was sent, never what. Nothing is copied from a care item the task may be linked to:
 * the proposal carries only what the volunteer already knew (the task's own label and date) and their words. It is
 * SCOPED to that item (proposals.scope_care_item_id, never shown): only those who may open the item review it, so a
 * flag on a restricted item reaches its owner and the clergy named on it and nobody else, in the Inbox, its count,
 * the connector and the phone notices. Nothing here logs; the audit row holds ids only.
 */
import { and, eq, isNull } from "drizzle-orm";
import { longDate } from "@/lib/format";
import { FLAG_MAX, flagProposalText, KIND_WORDS } from "@/lib/volunteers-wording";
import { scheduleReading } from "@/server/care/ai-reading";
import { writeLinkAudit } from "@/server/care/audit";
import { hasBadChars } from "@/server/care/bring-in-rules";
import { createVolunteerFlagProposal } from "@/server/care/intake";
import { volunteerClaims } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { atDailyLimit, atLimit, withinDailyLimit, withinLimit } from "@/server/meals/rate-limit";
import { manageAttempt, refused, stateOf, type Refused } from "./public";

export const FLAG_LIMITS = {
  /** Flags that SUCCEED on one claim per (UTC) day: one link cannot flood the clergy Inbox. */
  perClaimPerDay: 3,
  /** Flags per clock hour, from every link together, that are read and announced. Past it a flag is still kept, quietly. */
  allPerHour: 30,
  /** The hard ceiling: flags stored per clock hour from every link together. Past it a flag is refused ("try again"), so storage cannot be flooded. */
  storedPerHour: 200,
} as const;

/** The words as they will be kept (line breaks as \n, trimmed), or null when they are refused. */
export function flagWords(value: unknown): string | null {
  if (typeof value !== "string" || value.length > FLAG_MAX || hasBadChars(value)) return null;
  const words = value.replace(/\r\n/g, "\n").trim();
  return words.length > 0 ? words : null;
}

/**
 * Send "Something a rabbi should know" through a personal link. Protected as every personal-link action is (the
 * per-client cap, then the link), and also timed like a claim: the form's signed render time and the honeypot.
 * A cancelled claim, a cancelled task, a purged claim and an unknown link all answer "not found". A claim that is
 * done, or whose date has passed, may still send: that is often when a volunteer knows.
 */
export async function flagForRabbis(db: Db, manageToken: unknown, words: unknown, clientMeta: unknown, now: Date = new Date()): Promise<{ ok: true } | Refused> {
  const mine = await manageAttempt(db, manageToken, clientMeta, now, true);
  if ("ok" in mine) return mine;
  const state = stateOf(mine);
  if (state === "cancelled" || state === "task_cancelled") return refused("not_found");
  // An "every time" link has its own page, which has no such box yet.
  if (mine.claim.claimSetId) return refused("not_found");
  if (mine.bot) return refused("refused");
  const text = flagWords(words);
  if (text === null) return refused("invalid", ["words"]);
  const claimKey = `day:vol:flag:claim:${mine.claim.id}`;
  if ((await atDailyLimit(db, claimKey, FLAG_LIMITS.perClaimPerDay, now)) || (await atLimit(db, "vol:flag:stored", FLAG_LIMITS.storedPerHour, now))) return refused("rate_limited");
  const { task, claim } = mine;
  const when = task.timeWindow ? `${longDate(task.taskDate)}, ${task.timeWindow}` : longDate(task.taskDate);
  const rawText = flagProposalText({ firstName: claim.firstName, task: `${KIND_WORDS[task.kind]} for ${task.forLabel}`, when, words: text });
  const proposalId = await db.transaction(async (tx) => {
    // Re-checked inside: a claim cancelled (or a task cancelled, or a link purged) a moment ago sends nothing.
    const [row] = await tx
      .update(volunteerClaims)
      .set({ flaggedAt: now })
      .where(and(eq(volunteerClaims.id, claim.id), isNull(volunteerClaims.cancelledAt), isNull(volunteerClaims.purgedAt)))
      .returning({ id: volunteerClaims.id });
    if (!row) return null;
    // A task on a care item: only those who may open that item review this (a restricted item: its owner and the clergy named on it).
    const id = await createVolunteerFlagProposal(tx, rawText, task.careItemId);
    await writeLinkAudit(tx, "volunteer", "volunteer_claim.flag", "volunteer_claim", claim.id, { volunteerTaskId: task.id });
    return id;
  });
  if (!proposalId) return refused("not_found");
  await withinDailyLimit(db, claimKey, FLAG_LIMITS.perClaimPerDay, now);
  await withinLimit(db, "vol:flag:stored", FLAG_LIMITS.storedPerHour, now);
  // After the response: the AI reading (when on) and the clergy's phone notices (fixed words), as for the public form.
  // Past the hour's cap for every link together the words are still kept for the rabbis (nothing written is refused);
  // only the reading and the notices are skipped, so a flood can neither block a genuine volunteer nor ring phones.
  if (await withinLimit(db, "vol:flag:all", FLAG_LIMITS.allPerHour, now)) scheduleReading(db, proposalId);
  return { ok: true };
}
