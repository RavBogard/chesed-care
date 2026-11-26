/**
 * Turning email on for everyone brought in from the old spreadsheet. The owner only, everyone at once, never one by one
 * and never the lead (Daniel, 2026-11-26). It sends nothing itself. Who it covers: imported, still held, with an email
 * on their row, not someone who left or asked to stop, and not someone from "IL members" who has not volunteered.
 *
 * Consent is recorded honestly: consent_at stays empty (they never said yes in the app); emails_released_at says when
 * the owner turned it on. Each person's first email after this carries one sentence saying what this is and their stop
 * link (intro_pending; src/server/email/roster-gate.ts). One audit row, counts only.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { canReleaseImportedEmails, deny, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { InvalidInput } from "@/server/care/validate";
import { corpsMembers } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { stoppedAmong } from "./stopped";

async function releasable(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: corpsMembers.id, emailKey: corpsMembers.emailKey })
    .from(corpsMembers)
    .where(
      and(
        isNotNull(corpsMembers.importedAt),
        eq(corpsMembers.emailsHeld, true),
        isNotNull(corpsMembers.emailKey),
        eq(corpsMembers.notVolunteered, false),
        ne(corpsMembers.status, "left"),
        ne(corpsMembers.status, "pending"),
        isNull(corpsMembers.stoppedBy),
        isNull(corpsMembers.contactPurgedAt),
      ),
    );
  // Someone who asked to stop under another row is left out too.
  const stopped = await stoppedAmong(db, rows.map((r) => r.emailKey!));
  return rows.filter((r) => !stopped.has(r.emailKey!)).map((r) => r.id);
}

/** A hash of exactly who is covered (their sorted ids): what the confirm sheet passes back, so the set cannot change unseen. */
const setToken = (ids: string[]) => createHash("sha256").update([...ids].sort().join(",")).digest("base64url");

export type Releasable = { count: number; token: string };

/** How many people the switch would turn on, for its confirm sheet, and the token of exactly that set. */
export async function countReleasable(db: Db, actor: Actor): Promise<Releasable> {
  if (!canReleaseImportedEmails(actor)) deny();
  const ids = await releasable(db);
  return { count: ids.length, token: setToken(ids) };
}

/**
 * Turn it on. `token` is the one the confirm sheet showed with its count: if the set of people has changed since (even
 * with the same count), nothing changes and the owner is asked to look again. Returns how many were turned on.
 */
export async function releaseImportedEmails(db: Db, actor: Actor, token: unknown, now: Date = new Date()): Promise<number> {
  if (!canReleaseImportedEmails(actor)) deny();
  const ids = await releasable(db);
  if (typeof token !== "string" || token !== setToken(ids)) throw new InvalidInput("count");
  if (ids.length === 0) return 0;
  await db.transaction(async (tx) => {
    await tx
      .update(corpsMembers)
      .set({ emailsHeld: false, introPending: true, emailsReleasedAt: now })
      .where(and(inArray(corpsMembers.id, ids), eq(corpsMembers.emailsHeld, true)));
    // The subject is the owner who pressed it (as for other bulk changes): no one member stands for the set.
    await writeAudit(tx, actor, "corps_member.release_emails", "corps_import", actor.id, { counts: { released: ids.length } });
  });
  return ids.length;
}
