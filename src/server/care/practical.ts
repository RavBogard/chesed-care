/**
 * Practical requests: a public-form message the sender marked as practical help from Mitzvah Corps (a meal, a ride,
 * soup), shown to the Mitzvah Corps lead as well as the clergy.
 *
 * The lead's view is deliberately narrow and built here, field by field. It never carries the reading, the
 * reporter columns, the review scope or any other proposal: the row is selected by practicalRequestVisibleWhere
 * (policy.ts) and only the columns below are read. The sender's words are the form's own (intake and raw_text),
 * never the AI reading. Nothing here is logged; the audit entries carry only the action and the proposal id.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { canKeepToClergy, canSeePracticalRequests, canTakePracticalRequest, deny, practicalRequestVisibleWhere, proposalReviewWhere, type Actor } from "@/server/access/policy";
import { proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { writeAudit } from "./audit";
import { storedIntake } from "./intake";
import { NotFound, uuidOrNotFound } from "./validate";

export type PracticalRequest = {
  id: string;
  createdAt: Date;
  about: string;
  what: string;
  sender: string;
  contact: string;
  takenByName: string | null;
  takenAt: Date | null;
  /** Whether the actor is the one who took it. */
  takenByMe: boolean;
};

/** The practical requests the actor may see, oldest first. A request whose words are gone is left out. */
export async function listPracticalRequests(db: Db, actor: Actor): Promise<PracticalRequest[]> {
  if (!canSeePracticalRequests(actor)) deny();
  const rows = await db
    .select({ id: proposals.id, createdAt: proposals.createdAt, rawText: proposals.rawText, intake: proposals.intake, takenBy: proposals.takenBy, takenAt: proposals.takenAt, takerName: users.name, takerEmail: users.email })
    .from(proposals)
    .leftJoin(users, eq(users.id, proposals.takenBy))
    .where(practicalRequestVisibleWhere(actor))
    .orderBy(asc(proposals.createdAt));
  return rows.flatMap((r) => {
    const intake = storedIntake(r.intake);
    if (intake?.kind !== "public_form" || !r.rawText) return [];
    return [
      {
        id: r.id,
        createdAt: r.createdAt,
        about: intake.about,
        what: r.rawText,
        sender: intake.sender,
        contact: intake.contact,
        takenByName: r.takenBy ? (r.takerName ?? r.takerEmail ?? "Someone") : null,
        takenAt: r.takenAt,
        takenByMe: r.takenBy === actor.id,
      },
    ];
  });
}

export type TakeResult = { ok: true } | { ok: false; reason: "already_taken" };

/** "I'll take this": the first taker wins. A request the actor cannot see looks the same as one that does not exist. */
export async function takePracticalRequest(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<TakeResult> {
  if (!canTakePracticalRequest(actor)) deny();
  const proposalId = uuidOrNotFound(id);
  return db.transaction(async (tx) => {
    const [visible] = await tx.select({ id: proposals.id, takenBy: proposals.takenBy }).from(proposals).where(and(eq(proposals.id, proposalId), practicalRequestVisibleWhere(actor))).limit(1);
    if (!visible) throw new NotFound();
    if (visible.takenBy) return visible.takenBy === actor.id ? { ok: true as const } : { ok: false as const, reason: "already_taken" as const };
    // The condition is in the update itself, so two people pressing at once cannot both win.
    const won = await tx
      .update(proposals)
      .set({ takenBy: actor.id, takenAt: now })
      .where(and(eq(proposals.id, proposalId), isNull(proposals.takenBy), practicalRequestVisibleWhere(actor)))
      .returning({ id: proposals.id });
    if (won.length === 0) return { ok: false as const, reason: "already_taken" as const };
    await writeAudit(tx, actor, "proposal.practical_take", "proposal", proposalId);
    return { ok: true as const };
  });
}

/** Clergy pull a request back so the lead no longer sees it, and whoever took it is cleared. */
export async function keepToClergy(db: Db, actor: Actor, id: unknown): Promise<void> {
  if (!canKeepToClergy(actor)) deny();
  const proposalId = uuidOrNotFound(id);
  await db.transaction(async (tx) => {
    const done = await tx
      .update(proposals)
      .set({ leadVisible: false, takenBy: null, takenAt: null })
      .where(and(eq(proposals.id, proposalId), eq(proposals.status, "pending"), eq(proposals.practical, true), proposalReviewWhere(actor)))
      .returning({ id: proposals.id });
    if (done.length === 0) throw new NotFound();
    await writeAudit(tx, actor, "proposal.practical_keep", "proposal", proposalId);
  });
}
