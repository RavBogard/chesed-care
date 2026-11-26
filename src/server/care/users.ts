import { revokeAllCaptureTokens } from "./capture-tokens";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { ASSIGNABLE_ROLES, canManageUsers, deny, isClergyLevel, normalizeEmail, type Actor, type Role } from "@/server/access/policy";
import { careItemAccess, careItems, followUps, proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { revokeConnectionsForEmail } from "@/server/auth/connections";
import { writeAudit } from "./audit";
import { userColumns } from "@/server/db/user-columns";
import { InvalidInput, NotFound, oneOf, optionalText, uuidOrNotFound } from "./validate";

export type TeamMember = { id: string; email: string; name: string | null; role: Role; active: boolean };

/** Clergy see the team (to assign work); a caregiver sees only themselves. */
export async function listTeam(db: Db, actor: Actor): Promise<TeamMember[]> {
  const cols = { id: users.id, email: users.email, name: users.name, role: users.role, active: users.active };
  if (!isClergyLevel(actor)) return db.select(cols).from(users).where(eq(users.id, actor.id));
  return db.select(cols).from(users).orderBy(asc(users.name), asc(users.email));
}

/** Add someone to the allowlist. Owners only; the owner role itself comes from OWNER_EMAILS. */
export async function addUser(db: Db, actor: Actor, input: { email: unknown; name?: unknown; role: unknown }): Promise<TeamMember> {
  if (!canManageUsers(actor)) deny();
  if (typeof input.email !== "string") throw new InvalidInput("email");
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new InvalidInput("email");
  const role = oneOf(input.role, "role", ASSIGNABLE_ROLES);
  const [row] = await db
    .insert(users)
    .values({ email, name: optionalText(input.name, "name", 200), role, active: true })
    .onConflictDoNothing({ target: users.email })
    .returning(userColumns);
  if (!row) throw new InvalidInput("email");
  return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active };
}

/**
 * Change a team member's role or active flag. Owners only. OWNER_EMAILS is the
 * source of truth for owners: a current owner's row cannot be changed here, but a
 * row that still says owner after its email left OWNER_EMAILS is clergy, and can be
 * demoted or deactivated like any other (editing it rewrites the stale role).
 */
export async function updateUser(
  db: Db,
  actor: Actor,
  id: unknown,
  patch: { role?: unknown; active?: unknown },
  ownerEmails: ReadonlySet<string>,
): Promise<TeamMember> {
  if (!canManageUsers(actor)) deny();
  const userId = uuidOrNotFound(id);
  const [current] = await db.select(userColumns).from(users).where(eq(users.id, userId)).limit(1);
  if (!current) throw new NotFound();
  if (ownerEmails.has(normalizeEmail(current.email))) throw new InvalidInput("user");
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.role !== undefined) set.role = oneOf(patch.role, "role", ASSIGNABLE_ROLES);
  else if (current.role === "owner" && patch.active !== undefined) set.role = "clergy";
  if (patch.active !== undefined) {
    if (typeof patch.active !== "boolean") throw new InvalidInput("active");
    set.active = patch.active;
  }
  if (Object.keys(set).length === 0) return { id: current.id, email: current.email, name: current.name, role: current.role, active: current.active };
  const becomesCaregiver = set.role === "caregiver" && current.role !== "caregiver";
  const leavesCareTeam = set.role !== undefined && set.role !== "clergy" && set.role !== "caregiver";
  // No longer clergy, or no longer here at all.
  const leavesClergy = (set.role !== undefined && set.role !== "clergy") || set.active === false;
  const row = await db.transaction(async (tx) => {
    // A caregiver is never given clergy-only work: their follow-ups on clergy-only
    // care items, or on a person directly, become unassigned. (Their notes about
    // clergy-only people are hidden from them by the access policy.)
    if (becomesCaregiver) {
      const clergyOnlyItems = tx.select({ id: careItems.id }).from(careItems).where(eq(careItems.visibility, "clergy"));
      await tx
        .update(followUps)
        .set({ ownerUserId: null })
        .where(and(eq(followUps.ownerUserId, userId), or(isNull(followUps.careItemId), inArray(followUps.careItemId, clergyOnlyItems))));
    }
    // staff, lead and senior_staff hold no care work at all: every follow-up of theirs becomes unassigned.
    if (leavesCareTeam) await tx.update(followUps).set({ ownerUserId: null }).where(eq(followUps.ownerUserId, userId));
    // Someone who is no longer here holds no open work: it becomes unassigned, as on a demotion.
    if (set.active === false) await tx.update(followUps).set({ ownerUserId: null }).where(and(eq(followUps.ownerUserId, userId), isNull(followUps.doneAt)));
    if (leavesClergy) {
      // Only active clergy are named on restricted items; a later return does not bring old access back.
      await tx.delete(careItemAccess).where(eq(careItemAccess.userId, userId));
      // Their own captures, which only they could review, are dismissed and their words erased.
      const dismissed = await tx
        .update(proposals)
        .set({ status: "dismissed", decidedBy: actor.id, decidedAt: new Date(), rawText: null, reading: null })
        .where(and(eq(proposals.submittedBy, userId), eq(proposals.status, "pending"), eq(proposals.reviewScope, "submitter")))
        .returning({ id: proposals.id, channel: proposals.channel });
      for (const p of dismissed) await writeAudit(tx, actor, "proposal.dismiss", "proposal", p.id, { channel: p.channel });
    }
    // Deactivating someone ends their Claude connector too: every token and grant they hold.
    // Reactivating revokes as well: a token minted in a race with the deactivation must not resume
    // without the person approving the connection again.
    if (typeof set.active === "boolean") await revokeConnectionsForEmail(tx, current.email);
    // And their iPhone Shortcut keys. A key is never revived by reactivating: the person makes a new one.
    if (set.active === false) await revokeAllCaptureTokens(tx, userId);
    const [updated] = await tx.update(users).set(set).where(eq(users.id, userId)).returning(userColumns);
    // One row for every change of role or of the active flag, in the same transaction as the change.
    if (updated.role !== current.role || updated.active !== current.active) {
      await writeAudit(tx, actor, "user.change", "user", userId, { role: updated.role, previousRole: current.role, active: updated.active, previousActive: current.active });
    }
    return updated;
  });
  return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active };
}
