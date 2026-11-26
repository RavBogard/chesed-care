/**
 * The Inbox. Every arrival is a proposal; nothing reaches the care list until
 * clergy accept it. A clergy member's own capture is theirs to confirm and stays
 * out of the shared Inbox unless they release it.
 *
 * A proposal's raw text and reading are pastoral: never logged or audited, and
 * both cleared when the proposal is accepted or dismissed.
 */
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { canCreateProposal, canManageCareItems, canReleaseProposal, canReviewProposal, deny, proposalReviewWhere, reviewScopeFor, type Actor } from "@/server/access/policy";
import { careItemAccess, careItems, followUps, proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { createJourneyRun } from "@/server/journeys/journeys";
import { addEntry, MiSheberachBarred } from "@/server/misheberach/list";
import { JOURNEY_KEYS, MAX_STEPS } from "@/server/journeys/templates";
import { writeAudit } from "./audit";
import { firstFollowUpDue, LAST_CONTACT } from "./bring-in-rules";
import { assertCanHoldWorkOn, CARE_CATEGORIES, CARE_SOURCES, createCareItem, loadVisibleCareItem, type CareItem } from "./care-items";
import { recordContact } from "./contact-log";
import { batchIntake, storedIntake } from "./intake";
import { createOutsidePerson, type PersonSubjectInput } from "./outside-people";
import type { PersonDeps } from "./person-page";
import { resolvePersonRef } from "./person-ref";
import { reporterToKeep } from "./reporter";
import { readingField, readProposal, storedReading, type Reading } from "./reading";
import { dateField, InvalidInput, NotFound, oneOf, optionalText, text, uuidOrNotFound } from "./validate";

type Row = typeof proposals.$inferSelect;
export type Proposal = Omit<Row, "reading"> & { reading: Reading | null; submitterName: string | null; /** A practical request the Mitzvah Corps lead took: their name. */ takenByName: string | null };
/** All a reporter sees of their own report: when, its state, and who picked it up (no name when the item is restricted). */
export type MyReport = { id: string; createdOn: string; status: Row["status"]; pickedUpBy: string | null };

const RAW_MAX = 5000;
const view = (row: Row, submitterName: string | null, takenByName: string | null = null): Proposal => ({ ...row, reading: storedReading(row.reading), submitterName, takenByName });

/**
 * Report a need. Any signed-in user may. A clergy capture is reviewed by its
 * submitter unless they ask for the shared Inbox; everyone else's goes to clergy.
 */
export async function createProposal(db: Db, actor: Actor, input: { rawText?: unknown; channel: unknown; reading?: unknown; reviewScope?: unknown; intake?: unknown }): Promise<Proposal> {
  if (!canCreateProposal(actor)) deny();
  const rawText = optionalText(input.rawText, "rawText", RAW_MAX);
  const reading = readingField(input.reading) ?? (await readProposal(rawText));
  if (rawText === null && reading === null) throw new InvalidInput("rawText");
  const requested = input.reviewScope === undefined ? undefined : oneOf(input.reviewScope, "reviewScope", ["submitter", "clergy"] as const);
  // Only a "bring in your list" marker can be given here (which batch, which place); the other intakes have their own writers.
  const intake = input.intake === undefined ? null : batchIntake.safeParse(input.intake);
  if (intake && !intake.success) throw new InvalidInput("intake");
  const [row] = await db
    .insert(proposals)
    .values({ channel: oneOf(input.channel, "channel", CARE_SOURCES), submittedBy: actor.id, rawText, reading, reviewScope: reviewScopeFor(actor, requested), intake: intake?.data ?? null })
    .returning();
  return view(row, actor.name);
}

/** Pending proposals for the actor to review: the shared Inbox and their own captures. Other roles see nothing here. */
export async function listInbox(db: Db, actor: Actor): Promise<Proposal[]> {
  const taker = alias(users, "taker");
  const rows = await db
    .select({ row: proposals, name: users.name, email: users.email, takerName: taker.name, takerEmail: taker.email })
    .from(proposals)
    .leftJoin(users, eq(users.id, proposals.submittedBy))
    .leftJoin(taker, eq(taker.id, proposals.takenBy))
    .where(and(eq(proposals.status, "pending"), proposalReviewWhere(actor)))
    .orderBy(desc(proposals.createdAt));
  return rows.map((r) => view(r.row, r.name ?? r.email ?? r.row.submitterLabel, r.row.takenBy ? (r.takerName ?? r.takerEmail ?? "Someone") : null));
}

/** The actor's own reports, with nothing of the reading or the care item. */
export async function listMyReports(db: Db, actor: Actor): Promise<MyReport[]> {
  if (!canCreateProposal(actor)) deny();
  const rows = await db
    .select({ id: proposals.id, createdAt: proposals.createdAt, status: proposals.status, restricted: careItems.restricted, ownerName: users.name, ownerEmail: users.email })
    .from(proposals)
    .leftJoin(careItems, eq(careItems.id, proposals.resultCareItemId))
    .leftJoin(users, eq(users.id, careItems.ownerUserId))
    .where(eq(proposals.submittedBy, actor.id))
    .orderBy(desc(proposals.createdAt));
  return rows.map((r) => ({
    id: r.id,
    createdOn: chicagoToday(r.createdAt),
    status: r.status,
    pickedUpBy: r.status === "accepted" && r.restricted === false ? (r.ownerName ?? r.ownerEmail) : null,
  }));
}

/** A pending proposal the actor may review, or NotFound (missing and not theirs to see look the same). */
export async function loadPending(db: Db, actor: Actor, id: unknown): Promise<Row> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, uuidOrNotFound(id))).limit(1);
  if (!row || !canReviewProposal(actor, row)) throw new NotFound();
  if (row.status !== "pending") throw new InvalidInput("status");
  return row;
}

/** Decide a proposal once: a second decision (or a race) finds it no longer pending. */
async function decide(db: Db, actor: Actor, row: Row, status: "accepted" | "dismissed", now: Date): Promise<Row> {
  const [decided] = await db
    .update(proposals)
    .set({ status, decidedBy: actor.id, decidedAt: now, rawText: null, reading: null, intake: null })
    .where(and(eq(proposals.id, row.id), eq(proposals.status, "pending")))
    .returning();
  if (!decided) throw new InvalidInput("status");
  return decided;
}

/** The submitter moves their own capture to the shared Inbox. */
export async function releaseToInbox(db: Db, actor: Actor, id: unknown): Promise<Proposal> {
  const row = await loadPending(db, actor, id);
  if (!canReleaseProposal(actor, row)) throw new InvalidInput("reviewScope");
  return db.transaction(async (tx) => {
    const [released] = await tx
      .update(proposals)
      .set({ reviewScope: "clergy" })
      .where(and(eq(proposals.id, row.id), eq(proposals.status, "pending")))
      .returning();
    if (!released) throw new InvalidInput("status");
    await writeAudit(tx, actor, "proposal.release", "proposal", row.id, { channel: row.channel });
    return view(released, actor.name);
  });
}

export async function dismissProposal(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<Proposal> {
  const row = await loadPending(db, actor, id);
  return db.transaction(async (tx) => {
    const decided = await decide(tx, actor, row, "dismissed", now);
    await writeAudit(tx, actor, "proposal.dismiss", "proposal", row.id, { channel: row.channel });
    return view(decided, null);
  });
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** The final values, set by the clergy member accepting. */
export const decisionSchema = z.strictObject({
  /** Open a new care item, or add this to one that exists (the summary becomes a note on it). */
  target: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("new") }), z.strictObject({ kind: z.literal("existing"), careItemId: uuid })]),
  /** Who it is about (a new care item only): a Salesforce contact, an outside person, or a new outside person. */
  person: z
    .union([
      z.strictObject({ contactId: z.string().min(15).max(18) }),
      z.strictObject({ outsidePersonId: uuid }),
      z.strictObject({ newOutsidePerson: z.strictObject({ name: z.string().min(1).max(200), phone: z.string().max(40).optional(), email: z.string().max(254).optional(), note: z.string().max(200).optional() }) }),
    ])
    .optional(),
  category: z.enum(CARE_CATEGORIES).optional(),
  summary: z.string().max(500).optional(),
  location: z.string().max(200).optional(),
  learnedFrom: z.string().max(200).optional(),
  restricted: z.boolean().optional(),
  restrictedShowsCarer: z.boolean().optional(),
  accessUserIds: z.array(uuid).max(20).optional(),
  ownerUserId: uuid.optional(),
  followUp: z.strictObject({ title: z.string().min(1).max(200), dueDate: z.string(), ownerUserId: uuid.optional() }).optional(),
  /** A new item only: how long ago the last contact was. Logs nothing; with no follow-up and no journey given, it sets the first follow-up. */
  lastContact: z.enum(LAST_CONTACT).optional(),
  /** Put the name on the Mi Sheberach list too (offered in the accept sheet: ticked for a "yes" on the public form, unticked for "not sure"). */
  miSheberach: z.strictObject({ name: z.string().min(1).max(200), kind: z.enum(["dated", "standing"]).optional(), askedBy: z.string().max(200).optional(), /** The sender answered "no" to the Mi Sheberach question: only an explicit, audited override puts the name on the list anyway. */ override: z.boolean().optional() }).optional(),
  /** Start a journey on the item too, with the steps that were left ticked in the preview. */
  journey: z
    .strictObject({
      templateKey: z.enum(JOURNEY_KEYS),
      anchorDate: z.string(),
      secondDate: z.string().optional(),
      intervalWeeks: z.number().int().optional(),
      leadUserId: uuid.nullable().optional(),
      stepIds: z.array(z.string().max(40)).max(MAX_STEPS).optional(),
    })
    .optional(),
});

/** `miSheberach`: what became of the offer to add the name to the list. "barred": the person once asked not to be listed, so nothing was added. */
export type Accepted = { proposal: Proposal; careItemId: string; person: string; followUpId: string | null; miSheberach?: "added" | "already" | "barred" };

/**
 * Accept a proposal with the final values: a new care item (its source is the
 * proposal's channel), or a note of kind "other" added to an existing one, plus an
 * optional first follow-up. One transaction: all of it happens or none does.
 */
export async function acceptProposal(deps: PersonDeps, actor: Actor, id: unknown, decision: unknown): Promise<Accepted> {
  const { db } = deps;
  const row = await loadPending(db, actor, id);
  if (!canManageCareItems(actor)) deny();
  const parsed = decisionSchema.safeParse(decision);
  if (!parsed.success) throw new InvalidInput("decision");
  const d = parsed.data;
  // A sender who said no to the Mi Sheberach list is not put on it by an ordinary accept.
  if (d.miSheberach && row.miSheberachAnswer === "no" && d.miSheberach.override !== true) throw new InvalidInput("miSheberach");
  if (d.target.kind === "new" && (!d.person || !d.category)) throw new InvalidInput(d.person ? "category" : "person");
  if (d.target.kind === "existing" && !d.summary?.trim()) throw new InvalidInput("summary");
  // Salesforce is read before the transaction opens; the name and household come from there, never from the proposal.
  const contact = d.target.kind === "new" && d.person && "contactId" in d.person ? await resolvePersonRef(deps, actor, d.person.contactId) : null;

  // A note from a reading that looks sensitive is never written where others of that item can read it.
  const sensitive = storedReading(row.reading)?.restrictedSuggested === true;
  // An item brought in from the clergy member's own list is already being cared for: it starts open, not new.
  const fromList = storedIntake(row.intake)?.kind === "batch" && row.submittedBy === actor.id;
  const followUpInput: { title: string; dueDate: string; ownerUserId?: string } | undefined = d.followUp ?? (d.target.kind === "new" && d.lastContact && !d.journey ? { title: "Check in", dueDate: firstFollowUpDue(d.lastContact, chicagoToday(deps.now)) } : undefined);
  return db.transaction(async (tx) => {
    const decided = await decide(tx, actor, row, "accepted", deps.now);
    let item: CareItem;
    if (d.target.kind === "existing") {
      item = await loadVisibleCareItem(tx, actor, d.target.careItemId);
      if (item.status === "closed") throw new InvalidInput("careItemId");
      // Asking for a restricted record must never land the text on an open one.
      if (d.restricted === true && !item.restricted) throw new InvalidInput("restricted");
      const { sfContactId, outsidePersonId, sfAccountId, displayName } = item;
      // A report is not contact with the person, so a new item stays new.
      await recordContact(tx, actor, { sfContactId, outsidePersonId, sfAccountId, displayName, careItemId: item.id, kind: "other", occurredAt: deps.now, note: d.summary!.trim(), private: sensitive }, { countsAsContact: false });
    } else {
      const person = d.person!;
      let subject: PersonSubjectInput;
      if (contact) subject = contact;
      else if ("outsidePersonId" in person) subject = { outsidePersonId: person.outsidePersonId };
      else if ("newOutsidePerson" in person) subject = { outsidePersonId: (await createOutsidePerson(tx, actor, person.newOutsidePerson)).id };
      else throw new InvalidInput("person");
      item = await createCareItem(tx, actor, {
        ...subject,
        category: d.category,
        summary: d.summary,
        location: d.location,
        learnedFrom: d.learnedFrom,
        restricted: d.restricted,
        restrictedShowsCarer: d.restrictedShowsCarer,
        accessUserIds: d.accessUserIds,
        ownerUserId: d.ownerUserId,
        source: row.channel,
      });
      // ...and only when the one who brought it in is the one who now holds it.
      if (fromList && item.ownerUserId === actor.id) {
        await tx.update(careItems).set({ status: "open" }).where(eq(careItems.id, item.id));
        item = { ...item, status: "open" };
      }
    }
    let followUpId: string | null = null;
    if (followUpInput) {
      // Written here rather than through createFollowUp: the acceptor may be opening a restricted item for a colleague, which they will not see afterwards.
      const ownerUserId = followUpInput.ownerUserId ?? item.ownerUserId;
      await assertCanHoldWorkOn(tx, ownerUserId, item);
      const { sfContactId, outsidePersonId, sfAccountId, displayName } = item;
      const [followUp] = await tx
        .insert(followUps)
        .values({ careItemId: item.id, sfContactId, outsidePersonId, sfAccountId, displayName, title: text(followUpInput.title, "title", 200), dueDate: dateField(followUpInput.dueDate, "dueDate"), ownerUserId, createdBy: actor.id })
        .returning({ id: followUps.id });
      followUpId = followUp.id;
    }
    // Policy for this was decided above (clergy level, accepting this proposal): the acceptor may be opening a restricted item for a colleague.
    if (d.journey) await createJourneyRun(tx, actor, item, d.journey, deps.now);
    let miSheberach: Accepted["miSheberach"];
    if (d.miSheberach) {
      // Linked to the care item only when the acceptor fully sees it (a restricted item opened for a colleague is not linked); the name itself is read aloud, so it is added regardless.
      const base = { name: d.miSheberach.name, kind: d.miSheberach.kind, askedBy: d.miSheberach.askedBy, sfContactId: item.sfContactId, outsidePersonId: item.outsidePersonId };
      const source = row.channel === "form" ? "public_form" : "app";
      if (row.miSheberachAnswer === "no") await writeAudit(tx, actor, "mi_sheberach.add_over_no", "proposal", row.id, { channel: row.channel });
      try {
        const sees = !item.restricted || item.ownerUserId === actor.id || (await tx.select({ id: careItemAccess.userId }).from(careItemAccess).where(and(eq(careItemAccess.careItemId, item.id), eq(careItemAccess.userId, actor.id))).limit(1)).length > 0;
        const added = await addEntry(tx, actor, { ...base, ...(sees ? { careItemId: item.id } : {}) }, { source, now: deps.now });
        miSheberach = added.created ? "added" : "already";
      } catch (error) {
        if (!(error instanceof MiSheberachBarred)) throw error;
        miSheberach = "barred";
      }
    }
    const [linked] = await tx.update(proposals).set({ resultCareItemId: item.id, ...(reporterToKeep(row) ?? {}) }).where(eq(proposals.id, decided.id)).returning();
    await writeAudit(tx, actor, "proposal.accept", "proposal", row.id, { careItemId: item.id, channel: row.channel, target: d.target.kind, restricted: item.restricted });
    return { proposal: view(linked, null), careItemId: item.id, person: item.displayName, followUpId, ...(miSheberach ? { miSheberach } : {}) };
  });
}
