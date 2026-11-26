/**
 * Referrals to Mitzvah Corps: a rabbi sends the coordinator exactly what a volunteer needs (what kind of help, whether
 * the person has said yes, how to reach them, who is already involved) and whatever else the rabbi chooses to say.
 * What to tell her is the rabbi's decision; the app does not police the words. Clergy (owner, clergy)
 * refer and withdraw; the lead also sees the open ones, takes one and closes it with a line the clergy read.
 * Everyone else is refused by every function.
 *
 * Nothing is copied from a care record: a referral holds NO care category, summary or pastoral note and no care item id. The views are built here field by field.
 * Audit rows hold ids and enum values only, never a name, a contact line or a note. Nothing here is logged.
 */
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { REFERRAL_CONSENTS, REFERRAL_KINDS, REFERRAL_LIMITS, type ReferralConsent, type ReferralKind } from "@/lib/referral-wording";
import { canReferToCorps, canSeeCorpsReferrals, deny, isClergyLevel, outsidePersonVisibleWhere, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import type { PersonDeps } from "@/server/care/person-page";
import { resolvePersonRef } from "@/server/care/person-ref";
import { hasBadChars } from "@/server/care/bring-in-rules";
import { InvalidInput, NotFound, oneOf, optionalText, TooMany, uuidField, uuidOrNotFound } from "@/server/care/validate";
import { corpsReferrals, outsidePeople, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { withinLimit } from "@/server/meals/rate-limit";
import { afterResponse, noticeReferral } from "@/server/notify/notify";

export { REFERRAL_CONSENTS, REFERRAL_KINDS, type ReferralConsent, type ReferralKind };
export const CLOSED_AS = ["done", "declined", "withdrawn"] as const;
export type ClosedAs = (typeof CLOSED_AS)[number];

/** An open referral nobody has closed is withdrawn after this long, so nothing sits on the coordinator's list for ever. */
export const REFERRAL_OPEN_DAYS = 60;
/** A closed referral is deleted this long after it was closed. */
export const REFERRAL_RETENTION_DAYS = 90;
/** Referrals one person may make in an hour: far above a busy day, far below a loop. */
export const REFERRALS_PER_HOUR = 30;

/** One line: no line break or tab, and none of the control, invisible or direction-changing characters the house refuses. */
const line = (v: unknown, field: string, max: number): string | null => {
  const t = optionalText(v, field, max);
  if (t !== null && (/[\n\r\t]/.test(t) || hasBadChars(t))) throw new InvalidInput(field);
  return t;
};

/**
 * Referrals the viewer may know exist. As on the visiting list: an outside person is hidden from a clergy-level viewer
 * (the owner included) when every care item about them is restricted away from that viewer. The lead has no care
 * access and sees every referral that is ready for her, with no person link.
 */
function referralVisibleWhere(actor: Actor): SQL | undefined {
  // The coordinator does not learn of a referral while a rabbi is still asking the person: it reaches her only once they have agreed, or she is to ask.
  if (!isClergyLevel(actor)) return sql`${corpsReferrals.consent} <> 'rabbi_asks'`;
  return sql`(${corpsReferrals.outsidePersonId} is null or exists (select 1 from ${outsidePeople} where ${outsidePeople.id} = ${corpsReferrals.outsidePersonId} and ${outsidePersonVisibleWhere(actor)}))`;
}

export type ReferralInput = {
  sfContactId?: unknown;
  outsidePersonId?: unknown;
  kind?: unknown;
  consent?: unknown;
  contactLine?: unknown;
  mayShareAddress?: unknown;
  alreadyInvolved?: unknown;
  note?: unknown;
};

const given = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * Clergy refer a person, from the person's page. The name is read on the server, never taken from the form. One open
 * referral per person. It is allowed for any person the actor may see, whatever care they have: a referral is the
 * rabbi's own choice to tell Mitzvah Corps, it is tied to no care item, and it says nothing of one.
 */
export async function createReferral(db: Db, actor: Actor, input: ReferralInput, deps: { sf: PersonDeps["sf"]; now?: Date }): Promise<{ id: string }> {
  if (!canReferToCorps(actor)) deny();
  const now = deps.now ?? new Date();
  const hasOutside = given(input.outsidePersonId);
  if (given(input.sfContactId) === hasOutside) throw new InvalidInput("person");
  let sfContactId: string | null = null;
  let outsidePersonId: string | null = null;
  let displayName: string;
  if (hasOutside) {
    const id = uuidField(input.outsidePersonId, "outsidePersonId");
    // A person the viewer cannot see is answered exactly like one who does not exist.
    const [p] = await db.select({ id: outsidePeople.id, name: outsidePeople.name }).from(outsidePeople).where(and(eq(outsidePeople.id, id), outsidePersonVisibleWhere(actor))).limit(1);
    if (!p) throw new NotFound();
    outsidePersonId = p.id;
    displayName = p.name;
  } else {
    const person = await resolvePersonRef({ db, sf: deps.sf, now }, actor, input.sfContactId);
    sfContactId = person.sfContactId;
    displayName = person.displayName;
  }
  const kind = oneOf(input.kind, "kind", REFERRAL_KINDS);
  const consent = oneOf(input.consent, "consent", REFERRAL_CONSENTS);
  if (input.mayShareAddress !== undefined && typeof input.mayShareAddress !== "boolean") throw new InvalidInput("mayShareAddress");
  const values = {
    sfContactId,
    outsidePersonId,
    displayName,
    kind,
    consent,
    contactLine: line(input.contactLine, "contactLine", REFERRAL_LIMITS.contactLine),
    mayShareAddress: input.mayShareAddress === true,
    alreadyInvolved: line(input.alreadyInvolved, "alreadyInvolved", REFERRAL_LIMITS.alreadyInvolved),
    note: line(input.note, "note", REFERRAL_LIMITS.note),
    referredBy: actor.id,
    createdAt: now,
  };
  // Counted once everything checks out, so a typo does not use up the hour.
  if (!(await withinLimit(db, `corps-referral:${actor.id}`, REFERRALS_PER_HOUR, now))) throw new TooMany();
  const made = await db.transaction(async (tx) => {
    const [row] = await tx.insert(corpsReferrals).values(values).onConflictDoNothing().returning({ id: corpsReferrals.id });
    if (!row) throw new InvalidInput("person");
    await writeAudit(tx, actor, "corps_referral.create", "corps_referral", row.id, { referralKind: kind, consent });
    return row;
  });
  afterResponse(() => noticeReferral(db, made.id));
  return made;
}

async function loadOpen(db: Db, actor: Actor, id: unknown) {
  const [row] = await db.select().from(corpsReferrals).where(and(eq(corpsReferrals.id, uuidOrNotFound(id)), isNull(corpsReferrals.closedAt), referralVisibleWhere(actor))).limit(1);
  if (!row) throw new NotFound();
  return row;
}

/** Clergy say the person has now been asked: consent becomes "yes" or "the coordinator should ask". Never back to "a rabbi will ask". */
export async function setReferralConsent(db: Db, actor: Actor, id: unknown, consent: unknown): Promise<void> {
  if (!canReferToCorps(actor)) deny();
  const row = await loadOpen(db, actor, id);
  const next = oneOf(consent, "consent", ["yes", "coordinator_asks"] as const);
  if (row.consent === next) return;
  await db.transaction(async (tx) => {
    const done = await tx.update(corpsReferrals).set({ consent: next }).where(and(eq(corpsReferrals.id, row.id), isNull(corpsReferrals.closedAt))).returning({ id: corpsReferrals.id });
    if (done.length === 0) throw new NotFound();
    await writeAudit(tx, actor, "corps_referral.consent", "corps_referral", row.id, { consent: next });
  });
  afterResponse(() => noticeReferral(db, row.id));
}

/** Clergy take a referral back. It leaves the coordinator's list at once and is deleted 90 days later. */
export async function withdrawReferral(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<void> {
  if (!canReferToCorps(actor)) deny();
  const row = await loadOpen(db, actor, id);
  await db.transaction(async (tx) => {
    const done = await tx.update(corpsReferrals).set({ closedAt: now, closedBy: actor.id, closedAs: "withdrawn" }).where(and(eq(corpsReferrals.id, row.id), isNull(corpsReferrals.closedAt))).returning({ id: corpsReferrals.id });
    if (done.length === 0) throw new NotFound();
    await writeAudit(tx, actor, "corps_referral.close", "corps_referral", row.id, { closedAs: "withdrawn" });
  });
}

/** What the coordinator works from. Nothing of a care record, no care item id and no way to a person's page. */
export type OpenReferral = {
  id: string;
  name: string;
  kind: ReferralKind;
  consent: ReferralConsent;
  /** Null when there is none. */
  contactLine: string | null;
  mayShareAddress: boolean;
  alreadyInvolved: string | null;
  note: string | null;
  referredByName: string;
  createdAt: Date;
  takenByName: string | null;
  takenAt: Date | null;
  takenByMe: boolean;
  /** Nobody has it and the person may be contacted. */
  canTake: boolean;
};

/** The open referrals the actor may see, oldest first. */
export async function listOpenReferrals(db: Db, actor: Actor): Promise<OpenReferral[]> {
  if (!canSeeCorpsReferrals(actor)) deny();
  const referrer = alias(users, "referrer");
  const taker = alias(users, "taker");
  const rows = await db
    .select({
      id: corpsReferrals.id,
      name: corpsReferrals.displayName,
      kind: corpsReferrals.kind,
      consent: corpsReferrals.consent,
      contactLine: corpsReferrals.contactLine,
      mayShareAddress: corpsReferrals.mayShareAddress,
      alreadyInvolved: corpsReferrals.alreadyInvolved,
      note: corpsReferrals.note,
      createdAt: corpsReferrals.createdAt,
      takenBy: corpsReferrals.takenBy,
      takenAt: corpsReferrals.takenAt,
      referredBy: corpsReferrals.referredBy,
      referrerName: referrer.name,
      takerName: taker.name,
    })
    .from(corpsReferrals)
    .innerJoin(referrer, eq(referrer.id, corpsReferrals.referredBy))
    .leftJoin(taker, eq(taker.id, corpsReferrals.takenBy))
    .where(and(isNull(corpsReferrals.closedAt), referralVisibleWhere(actor)))
    .orderBy(asc(corpsReferrals.createdAt), asc(corpsReferrals.id));
  const clergy = isClergyLevel(actor);
  return rows.map((r) => {
    const waiting = r.consent === "rabbi_asks";
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as ReferralKind,
      consent: r.consent as ReferralConsent,
      contactLine: r.contactLine,
      mayShareAddress: r.mayShareAddress,
      alreadyInvolved: r.alreadyInvolved,
      note: r.note,
      // The coordinator needs to know whom to ask. Another rabbi does not: the name would say "this person is in Rabbi X's care" even where X's care item is restricted to say nothing.
      referredByName: !clergy || r.referredBy === actor.id ? (r.referrerName ?? "A rabbi") : "A rabbi",
      createdAt: r.createdAt,
      takenByName: r.takenBy ? (r.takerName ?? "Someone") : null,
      takenAt: r.takenAt,
      takenByMe: r.takenBy === actor.id,
      canTake: r.takenBy === null && !waiting,
    };
  });
}

export type TakeReferralResult = { ok: true } | { ok: false; reason: "already_taken" | "rabbi_asks_first" };

/** "I'll take this": the first taker wins. Not while a rabbi is still asking the person. */
export async function takeReferral(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<TakeReferralResult> {
  if (!canSeeCorpsReferrals(actor)) deny();
  const row = await loadOpen(db, actor, id);
  if (row.takenBy) return row.takenBy === actor.id ? { ok: true } : { ok: false, reason: "already_taken" };
  if (row.consent === "rabbi_asks") return { ok: false, reason: "rabbi_asks_first" };
  return db.transaction(async (tx) => {
    // The conditions are in the update itself, so two people pressing at once cannot both win.
    const won = await tx
      .update(corpsReferrals)
      .set({ takenBy: actor.id, takenAt: now })
      .where(and(eq(corpsReferrals.id, row.id), isNull(corpsReferrals.takenBy), isNull(corpsReferrals.closedAt), sql`${corpsReferrals.consent} <> 'rabbi_asks'`))
      .returning({ id: corpsReferrals.id });
    if (won.length === 0) return { ok: false as const, reason: "already_taken" as const };
    await writeAudit(tx, actor, "corps_referral.take", "corps_referral", row.id);
    return { ok: true as const };
  });
}

/** Whoever took a referral closes it: done, or the person said no thank you. The optional line is for the clergy. */
export async function closeReferral(db: Db, actor: Actor, id: unknown, input: { as: unknown; outcomeLine?: unknown }, now: Date = new Date()): Promise<void> {
  if (!canSeeCorpsReferrals(actor)) deny();
  const row = await loadOpen(db, actor, id);
  if (row.takenBy !== actor.id) deny();
  const closedAs = oneOf(input.as, "as", ["done", "declined"] as const);
  const outcomeLine = line(input.outcomeLine, "outcomeLine", REFERRAL_LIMITS.outcomeLine);
  await db.transaction(async (tx) => {
    const done = await tx.update(corpsReferrals).set({ closedAt: now, closedBy: actor.id, closedAs, outcomeLine }).where(and(eq(corpsReferrals.id, row.id), isNull(corpsReferrals.closedAt), eq(corpsReferrals.takenBy, actor.id))).returning({ id: corpsReferrals.id });
    if (done.length === 0) throw new NotFound();
    await writeAudit(tx, actor, "corps_referral.close", "corps_referral", row.id, { closedAs });
  });
}

export type PersonReferrals = {
  open: { id: string; kind: ReferralKind; consent: ReferralConsent; createdAt: Date; takenByName: string | null } | null;
  /** Closed in the last 90 days, newest first, with everything that was written: what the rabbi sent and the line the coordinator left (Daniel, 2026-11-25: what people write is kept for the rabbis to see). */
  closed: { id: string; kind: ReferralKind; closedAs: ClosedAs; closedAt: Date; outcomeLine: string | null; contactLine: string | null; alreadyInvolved: string | null; note: string | null }[];
};

/** For a person's page (clergy only): their open referral and the ones closed lately. Everyone else gets null and no hint that referrals exist. */
export async function referralsForPerson(db: Db, actor: Actor, ref: { sfContactId?: string | null; outsidePersonId?: string | null }, now: Date = new Date()): Promise<PersonReferrals | null> {
  if (!canReferToCorps(actor)) return null;
  const who = ref.outsidePersonId ? eq(corpsReferrals.outsidePersonId, ref.outsidePersonId) : ref.sfContactId ? eq(corpsReferrals.sfContactId, ref.sfContactId) : null;
  if (!who) return null;
  const since = new Date(now.getTime() - REFERRAL_RETENTION_DAYS * 86_400_000);
  const rows = await db
    .select({ id: corpsReferrals.id, kind: corpsReferrals.kind, consent: corpsReferrals.consent, createdAt: corpsReferrals.createdAt, takenBy: corpsReferrals.takenBy, takerName: users.name, closedAt: corpsReferrals.closedAt, closedAs: corpsReferrals.closedAs, outcomeLine: corpsReferrals.outcomeLine, contactLine: corpsReferrals.contactLine, alreadyInvolved: corpsReferrals.alreadyInvolved, note: corpsReferrals.note })
    .from(corpsReferrals)
    .leftJoin(users, eq(users.id, corpsReferrals.takenBy))
    .where(and(who, referralVisibleWhere(actor), or(isNull(corpsReferrals.closedAt), gte(corpsReferrals.closedAt, since))))
    .orderBy(desc(corpsReferrals.closedAt));
  const open = rows.find((r) => r.closedAt === null);
  return {
    open: open ? { id: open.id, kind: open.kind as ReferralKind, consent: open.consent as ReferralConsent, createdAt: open.createdAt, takenByName: open.takenBy ? (open.takerName ?? "Someone") : null } : null,
    closed: rows.flatMap((r) => (r.closedAt && r.closedAs ? [{ id: r.id, kind: r.kind as ReferralKind, closedAs: r.closedAs as ClosedAs, closedAt: r.closedAt, outcomeLine: r.outcomeLine, contactLine: r.contactLine, alreadyInvolved: r.alreadyInvolved, note: r.note }] : [])),
  };
}

/** Daily: an open referral nobody took in 60 days is withdrawn (nobody's name on it; one a coordinator is working is left alone; what was written stays), and referrals closed 90 or more days ago are deleted. No actor; counts only. */
export async function purgeReferrals(db: Db, now: Date = new Date()): Promise<{ lapsed: number; deleted: number }> {
  const stale = new Date(now.getTime() - REFERRAL_OPEN_DAYS * 86_400_000);
  const lapsed = await db.update(corpsReferrals).set({ closedAt: now, closedAs: "withdrawn" }).where(and(isNull(corpsReferrals.closedAt), isNull(corpsReferrals.takenBy), lte(corpsReferrals.createdAt, stale))).returning({ id: corpsReferrals.id });
  const cutoff = new Date(now.getTime() - REFERRAL_RETENTION_DAYS * 86_400_000);
  const gone = await db.delete(corpsReferrals).where(and(isNotNull(corpsReferrals.closedAt), lte(corpsReferrals.closedAt, cutoff))).returning({ id: corpsReferrals.id });
  return { lapsed: lapsed.length, deleted: gone.length };
}
