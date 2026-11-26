/**
 * The public Mitzvah Corps form and the "stop asking me" link. NO ACTOR: like "Let the clergy know", the route builds
 * a clientMeta from things the client cannot choose and passes it here. The answer never depends on whether anyone
 * is already on the roster: a new person, a repeat submission and a robot all get `{ ok: true }`.
 *
 *  - A new contact becomes a PENDING member: not asked, and deleted after 14 days, until a coordinator accepts them.
 *  - A contact that already exists (on the roster, paused, left, or purged after leaving) CHANGES NOTHING on that
 *    member: not name, skills, availability, status, pause, left date or consent. Only a timestamp is recorded,
 *    "asked to join again", for a coordinator to see and act on.
 *  - The caps count only new rows, so repeat submissions never use them up. Once a cap is reached EVERY valid submission
 *    gets the same plain "could not take this" answer before anything is looked up, and nothing is stored: no
 *    oracle on who is on the list, and nobody is thanked for a submission that was dropped.
 * Nothing is logged: no names, contacts or words.
 */
import { eq } from "drizzle-orm";
import { writeLinkAudit } from "@/server/care/audit";
import { corpsMembers, visitingList } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { badFields, clientMetaInput } from "@/server/meals/input";
import { atDailyLimit, atLimit, readClient, withinDailyLimit, withinLimit } from "@/server/meals/rate-limit";
import { newToken, tokenHash } from "@/server/meals/tokens";
import { normalizeContact } from "./input";
import { memberOfSignedStop } from "./stop-link";
import { contactsOf, joinInput } from "./roster-input";
import { recordStopped, stoppedAmong } from "./stopped";

export const JOIN_LIMITS = {
  /** Valid submissions from one client per clock hour. */
  perClient: 10,
  /** NEW pending members the form may make per clock hour, from everyone. */
  newPerHour: 60,
  /** NEW pending members the form may make per day, from everyone. */
  newPerDay: 300,
  /** Stop-link attempts from one client per clock hour. */
  stopPerClient: 30,
} as const;
/** A member the form made who is not accepted by then is deleted. */
export const PENDING_DAYS = 14;

export type JoinRefusal = { ok: false; reason: "stale" | "invalid" | "limited" | "capped" | "refused"; fields: string[] };
export type JoinResult = { ok: true } | JoinRefusal;
const no = (reason: JoinRefusal["reason"], fields: string[] = []): JoinRefusal => ({ ok: false, reason, fields });

/** `onNew`: told once about a NEW member who gave an email address (never for an existing contact or a returning one), with the plain stop token, which is kept in memory only long enough to email it. */
export type JoinHooks = { onNew?: (joined: { memberId: string; email: string; stopToken: string }) => void };

export async function submitJoin(db: Db, input: unknown, meta: unknown, now: Date = new Date(), hooks: JoinHooks = {}): Promise<JoinResult> {
  const parsedMeta = clientMetaInput.safeParse(meta);
  if (!parsedMeta.success) return no("refused");
  if (parsedMeta.data.elapsedMs === null || parsedMeta.data.elapsedMs === undefined) return no("stale");
  const client = readClient(parsedMeta.data, now, true);
  if (!client) return no("refused");
  if (client.bot) return { ok: true };
  const parsed = joinInput.safeParse(input);
  if (!parsed.success) return no("invalid", badFields(parsed.error));
  if (!(await withinLimit(db, `join:client:${client.hash}`, JOIN_LIMITS.perClient, now))) return no("limited");
  // A cap that is reached answers everyone alike, before any lookup.
  if ((await atLimit(db, "join:new:hour", JOIN_LIMITS.newPerHour, now)) || (await atDailyLimit(db, "day:join:new", JOIN_LIMITS.newPerDay, now))) return no("capped");
  const v = parsed.data;
  const n = normalizeContact(v.contact)!;
  const isEmail = v.contact.includes("@");
  const contacts = contactsOf(isEmail ? { email: v.contact } : { mobile: v.contact })!;
  const [existing] = await db.select({ id: corpsMembers.id }).from(corpsMembers).where(eq(isEmail ? corpsMembers.emailKey : corpsMembers.mobileKey, n.key)).limit(1);
  if (existing) {
    // Nothing of theirs changes: only a flag for a coordinator.
    await db.update(corpsMembers).set({ askedToJoinAgainAt: now }).where(eq(corpsMembers.id, existing.id));
    await writeLinkAudit(db, "volunteer", "corps_member.join", "corps_member", existing.id, { memberId: existing.id });
    return { ok: true };
  }
  // Only a new row counts; a race past the cap is refused the same way.
  if (!(await withinLimit(db, "join:new:hour", JOIN_LIMITS.newPerHour, now)) || !(await withinDailyLimit(db, "day:join:new", JOIN_LIMITS.newPerDay, now))) return no("capped");
  const returning = (await stoppedAmong(db, [n.key])).has(n.key);
  const stopToken = newToken();
  const [row] = await db
    .insert(corpsMembers)
    .values({
      firstName: v.firstName,
      lastName: v.lastName,
      ...contacts,
      canDo: v.canDo,
      availability: v.availability ?? null,
      howOften: v.howOften ?? null,
      preferContact: v.preferContact ?? null,
      status: "pending",
      source: "form",
      joinedOn: chicagoToday(now),
      consentAt: now,
      stopTokenHash: tokenHash(stopToken),
      // Someone who stopped before comes back only when a coordinator confirms it.
      ...(returning ? { stoppedBy: "self" as const, askedToJoinAgainAt: now } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: corpsMembers.id });
  if (row) await writeLinkAudit(db, "volunteer", "corps_member.join", "corps_member", row.id, { memberId: row.id });
  if (row && isEmail && !returning) hooks.onNew?.({ memberId: row.id, email: n.contact, stopToken });
  return { ok: true };
}

/** The member a stop link stands for: a signed link (see stop-link.ts) or the member's own stop token. */
async function memberByStop(db: Db, presented: unknown) {
  const signed = memberOfSignedStop(presented);
  const [member] = await db
    .select()
    .from(corpsMembers)
    .where(signed ? eq(corpsMembers.id, signed) : eq(corpsMembers.stopTokenHash, tokenHash(presented)))
    .limit(1);
  return member ?? null;
}

/** Whether a stop link is one that works (it opens the confirm page). Reads only. */
export async function stopLinkWorks(db: Db, token: unknown): Promise<boolean> {
  return (await memberByStop(db, token)) !== null;
}

export type StopResult = { ok: true } | { ok: false; reason: "not_found" | "limited" | "refused" };

/**
 * The confirm button, a POST. Marks the member as left by their own choice (`stopped_by` self), turns off their "ask me
 * again" ticks and remembers a hash of their contact. Doing it twice is the same as once.
 */
export async function stopAsking(db: Db, token: unknown, meta: unknown, now: Date = new Date()): Promise<StopResult> {
  const client = readClient(meta, now, false);
  if (!client) return { ok: false, reason: "refused" };
  if (!(await withinLimit(db, `join:stop:${client.hash}`, JOIN_LIMITS.stopPerClient, now))) return { ok: false, reason: "limited" };
  if (client.bot) return { ok: true };
  const member = await memberByStop(db, token);
  if (!member) return { ok: false, reason: "not_found" };
  if (member.status !== "left") {
    await db.transaction(async (tx) => {
      await tx.update(corpsMembers).set({ status: "left", pausedUntil: null, leftAt: now, stoppedBy: "self" }).where(eq(corpsMembers.id, member.id));
      await tx.update(visitingList).set({ visitorMemberId: null, visitorSetBy: null }).where(eq(visitingList.visitorMemberId, member.id));
      await recordStopped(tx, member);
      await writeLinkAudit(tx, "volunteer", "corps_member.stop", "corps_member", member.id, { memberId: member.id });
    });
  }
  return { ok: true };
}
