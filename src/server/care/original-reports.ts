/**
 * "Original report": the words of a report as they arrived, kept after a rabbi accepts or dismisses it
 * (Daniel, 2026-11-25: "When anyone writes, nothing should be refused. We want to maintain that information
 * because that's useful for the rabbis to see.").
 *
 * Who reads them is decided here and nowhere else, clergy level only:
 * - ACCEPTED into a care item: those who fully see that item now (careItemVisibleWhere, the SQL twin of
 *   canSeeCareItem: a restricted item's words are for its owner and the clergy named on it; no stub, and no
 *   role, the owner included, overrides it). When the words went into a note private to the acceptor
 *   (proposals.words_private), only the acceptor, and only while they still see the item.
 * - DISMISSED: a clergy member who could have reviewed it (canReviewProposal: the shared Inbox, or their own).
 * Staff, leads, senior staff, caregivers and the person who sent the report never read them back.
 *
 * The words are pastoral: plain text, never logged, emailed, pushed or audited, and not in the connector.
 */
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { canReadOriginalReports, canReviewProposal, careItemVisibleWhere, type Actor } from "@/server/access/policy";
import { careItems, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { NotFound, uuidOrNotFound } from "./validate";

type Row = typeof proposals.$inferSelect;
export type OriginalReport = { proposalId: string; words: string; channel: Row["channel"]; receivedAt: Date };

/** The original reports behind each of these care items, oldest first, for the items the actor fully sees. Anyone else gets an empty map. */
export async function getOriginalReports(db: Db, actor: Actor, careItemIds: string[]): Promise<Map<string, OriginalReport[]>> {
  const out = new Map<string, OriginalReport[]>();
  if (careItemIds.length === 0 || !canReadOriginalReports(actor)) return out;
  const rows = await db
    .select({ itemId: careItems.id, proposalId: proposals.id, words: proposals.rawText, channel: proposals.channel, receivedAt: proposals.createdAt })
    .from(proposals)
    .innerJoin(careItems, eq(careItems.id, proposals.resultCareItemId))
    .where(
      and(
        eq(proposals.status, "accepted"),
        isNotNull(proposals.rawText),
        inArray(careItems.id, careItemIds),
        careItemVisibleWhere(actor),
        or(eq(proposals.wordsPrivate, false), eq(proposals.decidedBy, actor.id)),
      ),
    )
    .orderBy(asc(proposals.createdAt));
  for (const { itemId, words, ...rest } of rows) {
    if (!words) continue;
    out.set(itemId, [...(out.get(itemId) ?? []), { ...rest, words }]);
  }
  return out;
}

/**
 * The words of one dismissed report, for a clergy member who could have reviewed it. Missing, not dismissed,
 * not theirs to review and already erased all look the same: NotFound. No screen shows this yet.
 */
export async function getDismissedReport(db: Db, actor: Actor, id: unknown): Promise<OriginalReport> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, uuidOrNotFound(id))).limit(1);
  if (!row || row.status !== "dismissed" || !row.rawText || !canReadOriginalReports(actor) || !canReviewProposal(actor, row)) throw new NotFound();
  return { proposalId: row.id, words: row.rawText, channel: row.channel, receivedAt: row.createdAt };
}
