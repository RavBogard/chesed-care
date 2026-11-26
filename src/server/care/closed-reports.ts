/**
 * "Closed without action": the dismissed reports whose words the clergy may read back, and Reopen, which puts one back
 * in the Inbox as pending.
 *
 * Who: clergy level only, and of the dismissed reports exactly those getDismissedReport (original-reports.ts) returns:
 * one from the shared Inbox for every rabbi, a rabbi's own private capture for that rabbi alone. The rule is decided in
 * SQL (dismissedReportWhere in policy.ts), for the rows, the count and the paging cursor alike. Everyone else is refused.
 *
 * What a dismissal cleared stays cleared: the AI reading and the intake (a public sender's name and contact) are gone
 * for good, so a reopened report is pending with its words and nothing else. The words are pastoral: never logged,
 * emailed or audited; the audit row of a reopen holds the proposal id and its channel.
 */
import { and, count, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { canReadOriginalReports, canReviewProposal, deny, dismissedReportWhere, proposalReviewWhere, type Actor } from "@/server/access/policy";
import { proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { writeAudit } from "./audit";
import { InvalidInput, NotFound, uuidField, uuidOrNotFound } from "./validate";

type Row = typeof proposals.$inferSelect;

/** One dismissed report, as the page gets it: nothing of the reading, the intake or the reporter columns. */
export type ClosedReport = {
  id: string;
  channel: Row["channel"];
  receivedAt: Date;
  closedAt: Date | null;
  /** The rabbi who closed it. */
  closedByName: string | null;
  /** Where it came from, when known: the person who sent it, or the source's own label ("Public form", "Salesforce", "Staff"). */
  from: string | null;
  /** The viewer's own capture, which only they ever saw. */
  ownCapture: boolean;
  words: string;
};

export const CLOSED_PAGE_SIZE = 25;
const CURSOR = "cursor_row";

/** Newest closed first: when it was closed (or arrived, for a row with no date of closing), then id, so a page boundary never splits a tie. */
const sortKey = (p: { decidedAt: AnyColumn; createdAt: AnyColumn }) => sql`coalesce(${p.decidedAt}, ${p.createdAt})`;

/** How many there are for the actor: the Inbox's quiet link. Clergy level only. */
export async function countClosedReports(db: Db, actor: Actor): Promise<number> {
  if (!canReadOriginalReports(actor)) deny();
  const [row] = await db.select({ n: count() }).from(proposals).where(dismissedReportWhere(actor));
  return Number(row?.n ?? 0);
}

/**
 * A page of them, newest closed first. `before`: the id of the last report on the previous page (the cursor holds no
 * words). `older`: the cursor for the next page, or null when this is the last.
 */
export async function listClosedReports(db: Db, actor: Actor, opts: { before?: unknown } = {}): Promise<{ reports: ClosedReport[]; older: string | null }> {
  if (!canReadOriginalReports(actor)) deny();
  const submitter = alias(users, "submitter");
  const closer = alias(users, "closer");
  let after: SQL | undefined;
  if (opts.before !== undefined) {
    const cursor = alias(proposals, CURSOR);
    // The cursor row must be one the actor may review, so an id from elsewhere tells them nothing of when it was closed.
    // (An alias renders as its bare name in a sql template, so the table is named here.)
    after = sql`(${sortKey(proposals)}, ${proposals.id}) < (select ${sortKey(cursor)}, ${cursor.id} from ${proposals} ${sql.identifier(CURSOR)} where ${cursor.id} = ${uuidField(opts.before, "before")} and ${proposalReviewWhere(actor, cursor)})`;
  }
  const rows = await db
    .select({
      id: proposals.id,
      channel: proposals.channel,
      receivedAt: proposals.createdAt,
      closedAt: proposals.decidedAt,
      words: proposals.rawText,
      submittedBy: proposals.submittedBy,
      submitterLabel: proposals.submitterLabel,
      reviewScope: proposals.reviewScope,
      submitterName: submitter.name,
      submitterEmail: submitter.email,
      closerName: closer.name,
      closerEmail: closer.email,
    })
    .from(proposals)
    .leftJoin(submitter, eq(submitter.id, proposals.submittedBy))
    .leftJoin(closer, eq(closer.id, proposals.decidedBy))
    .where(and(dismissedReportWhere(actor), after))
    .orderBy(desc(sortKey(proposals)), desc(proposals.id))
    .limit(CLOSED_PAGE_SIZE + 1);
  const reports = rows.slice(0, CLOSED_PAGE_SIZE).map((r) => ({
    id: r.id,
    channel: r.channel,
    receivedAt: r.receivedAt,
    closedAt: r.closedAt,
    closedByName: r.closerName ?? r.closerEmail,
    from: r.submittedBy ? (r.submitterName ?? r.submitterEmail) : r.submitterLabel,
    ownCapture: r.submittedBy === actor.id && r.reviewScope === "submitter",
    // dismissedReportWhere already requires the words.
    words: r.words ?? "",
  }));
  return { reports, older: rows.length > CLOSED_PAGE_SIZE ? reports[reports.length - 1].id : null };
}

/**
 * Put a dismissed report back in the Inbox: pending again, with who closed it and when cleared. Once only: the
 * condition is in the UPDATE, so of two at once one wins and the other is told it is no longer closed. Missing, or not
 * the actor's to see, is NotFound; one they see that is not closed (pending, accepted) is InvalidInput("status").
 */
export async function reopenProposal(db: Db, actor: Actor, id: unknown): Promise<{ id: string }> {
  if (!canReadOriginalReports(actor)) deny();
  const proposalId = uuidOrNotFound(id);
  return db.transaction(async (tx) => {
    const [reopened] = await tx
      .update(proposals)
      .set({ status: "pending", decidedBy: null, decidedAt: null, takenBy: null, takenAt: null, leadVisible: false })
      .where(and(eq(proposals.id, proposalId), dismissedReportWhere(actor)))
      .returning({ id: proposals.id, channel: proposals.channel });
    if (!reopened) {
      const [row] = await tx.select({ status: proposals.status, rawText: proposals.rawText, submittedBy: proposals.submittedBy, reviewScope: proposals.reviewScope }).from(proposals).where(eq(proposals.id, proposalId)).limit(1);
      // A dismissed report whose words were erased is not on the list, so it is not found either.
      if (!row || !canReviewProposal(actor, row) || (row.status === "dismissed" && row.rawText === null)) throw new NotFound();
      throw new InvalidInput("status");
    }
    await writeAudit(tx, actor, "proposal.reopen", "proposal", reopened.id, { channel: reopened.channel });
    return { id: reopened.id };
  });
}
