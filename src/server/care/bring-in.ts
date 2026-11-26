/**
 * "Bring in your list": a clergy member's own current caseload, confirmed entry by entry.
 *
 * Each confirmed entry becomes an ordinary proposal, the clergy member's own capture
 * (quick-capture channel, reviewed only by them), marked with which batch it belongs
 * to and its place in the list; the marker holds no words. All entries are written in
 * one transaction. Nothing here widens who sees anything. The words are pastoral:
 * never logged.
 */
import { randomUUID } from "node:crypto";
import { canManageCareItems, deny, isClergyLevel, type Actor } from "@/server/access/policy";
import { withinLimit } from "@/server/meals/rate-limit";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { type Accepted, acceptProposal, createProposal, listInbox, loadPending, type Proposal } from "./proposals";
import { ENTRIES_MAX, ENTRY_MAX, firstFollowUpDue, hasBadChars, LAST_CONTACT, LIST_MAX, sameNameExactly, stripInvisible, touchesSensitiveFloor, type LastContact } from "./bring-in-rules";
import { listCareItems, listCareItemStubs } from "./care-items";
import { storedIntake } from "./intake";
import type { PersonDeps } from "./person-page";
import { createMatcher, LIST_MAX_NAMES } from "./reading-match";
import { storedReading } from "./reading";
import { InvalidInput, oneOf, TooMany } from "./validate";

/** Lists one person may bring in per clock hour. */
export const BATCHES_PER_HOUR = 2;

/** The entries, checked as text from a person: 1 to 40, none empty, none over 1,000 characters, 8,000 in all, no control or invisible characters. */
export function entryList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > ENTRIES_MAX) throw new InvalidInput("entries");
  const texts = v.map((raw, i) => {
    // Direction marks, joiners and the like ride along with pasted text: removed. Anything else that is not text is refused, naming the entry.
    const e = typeof raw === "string" ? stripInvisible(raw) : raw;
    if (typeof e !== "string" || !e.trim() || e.length > ENTRY_MAX || hasBadChars(e)) throw new InvalidInput(`entry ${i + 1}`);
    return e.trim();
  });
  if (texts.reduce((n, e) => n + e.length, 0) > LIST_MAX) throw new InvalidInput("entries");
  return texts;
}

/** Save the confirmed entries as the actor's own proposals, all or none. Clergy level. The readings are scheduled by the caller. */
export async function createBatch(db: Db, actor: Actor, entries: unknown, now: Date = new Date()): Promise<{ batch: string; ids: string[] }> {
  if (!isClergyLevel(actor)) deny();
  const texts = entryList(entries);
  if (!(await withinLimit(db, `bringin:batch:${actor.id}`, BATCHES_PER_HOUR, now))) throw new TooMany();
  const batch = randomUUID();
  const ids = await db.transaction(async (tx) => {
    const made: string[] = [];
    for (const [n, rawText] of texts.entries()) {
      made.push((await createProposal(tx, actor, { rawText, channel: "capture", reviewScope: "submitter", intake: { kind: "batch", batch, n, total: texts.length } })).id);
    }
    return made;
  });
  return { batch, ids };
}

export type QueueItem = { proposal: Proposal; n: number; total: number };

/** The actor's own entries still waiting from their newest list, in the order they were listed. Clergy level. */
export async function listBatchQueue(db: Db, actor: Actor): Promise<QueueItem[]> {
  if (!isClergyLevel(actor)) deny();
  const mine = (await listInbox(db, actor)).flatMap((proposal) => {
    const intake = storedIntake(proposal.intake);
    return intake?.kind === "batch" && proposal.submittedBy === actor.id ? [{ proposal, intake }] : [];
  });
  if (mine.length === 0) return [];
  const newest = mine[0].intake.batch;
  return mine
    .filter((m) => m.intake.batch === newest)
    .map((m) => ({ proposal: m.proposal, n: m.intake.n, total: m.intake.total }))
    .sort((a, b) => a.n - b.n);
}

export type QuickPerson = { contactId: string } | { outsidePersonId: string };
/** Who a one-tap accept would be for, with what the card must show to catch a wrong match. */
export type QuickMatch = { subject: QuickPerson; name: string; household: string | null; place: string | null; member: boolean };

type QuickFacts = { reading: unknown; intake: unknown; submittedBy: string | null; reviewScope: string; rawText: string | null };

/**
 * Whether an entry may be accepted in one tap, and for whom. Decided here from the stored row and a fresh match
 * for this viewer, never from anything a client says:
 * - it is the actor's OWN entry from a list they brought in;
 * - the reading has a kind, does not look sensitive, and neither the words nor the summary touch the fixed
 *   sensitive-word floor;
 * - the one name it holds matches exactly one person, with the same words as the name written (no truncated
 *   search, no extra or missing names);
 * - that person has no open care item the words could be added to, and none held by a colleague (a stub).
 * Otherwise the sheet opens.
 */
export async function quickPerson(deps: PersonDeps, actor: Actor, p: QuickFacts): Promise<QuickMatch | null> {
  if (storedIntake(p.intake)?.kind !== "batch" || p.submittedBy !== actor.id || p.reviewScope !== "submitter") return null;
  const reading = storedReading(p.reading);
  if (!reading?.category || reading.restrictedSuggested === true || !reading.names?.length) return null;
  if (touchesSensitiveFloor(p.rawText) || touchesSensitiveFloor(reading.summary)) return null;
  const found = await createMatcher({ db: deps.db, sf: deps.sf }, actor, { maxNames: LIST_MAX_NAMES })(reading.names);
  if (found.length !== 1 || found[0].state !== "one" || !found[0].chosen) return null;
  const who = found[0].chosen;
  if (!sameNameExactly(found[0].name, who.name)) return null;
  const person = who.kind === "sf" ? { sfContactId: who.contactId } : { outsidePersonId: who.id };
  const items = await listCareItems(deps.db, actor, { status: "active", today: chicagoToday(deps.now), ...person });
  if (items.length > 0 || (await listCareItemStubs(deps.db, actor, person)).length > 0) return null;
  return who.kind === "sf"
    ? { subject: { contactId: who.contactId }, name: who.name, household: who.household, place: who.place, member: true }
    : { subject: { outsidePersonId: who.id }, name: who.name, household: null, place: who.note, member: false };
}

/** Accept an entry with the reading's values in one step, only where `quickPerson` allows. Anything else is refused (InvalidInput "quick"). */
export async function acceptQuick(deps: PersonDeps, actor: Actor, id: unknown, input: { lastContact?: unknown; checkIn?: unknown }): Promise<Accepted> {
  const row = await loadPending(deps.db, actor, id);
  if (!canManageCareItems(actor)) deny();
  const lastContact: LastContact = input.lastContact === undefined || input.lastContact === "" ? "unsure" : oneOf(input.lastContact, "lastContact", LAST_CONTACT);
  const match = await quickPerson(deps, actor, row);
  const reading = storedReading(row.reading);
  if (!match || !reading?.category) throw new InvalidInput("quick");
  // "Keep in touch every 4 weeks": the standing check-in starts on the day the first follow-up falls due, and its first step is that follow-up.
  const journey = input.checkIn === true ? { templateKey: "standing", anchorDate: firstFollowUpDue(lastContact, chicagoToday(deps.now)), intervalWeeks: 4 } : undefined;
  return acceptProposal(deps, actor, id, {
    target: { kind: "new" },
    person: match.subject,
    category: reading.category,
    summary: reading.summary ?? "",
    restricted: false,
    lastContact,
    ...(journey ? { journey } : {}),
  });
}
