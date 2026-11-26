import type { InboxEntry } from "@/components/inbox-card";
import type { PersonChoice } from "@/components/person-picker";
import type { Actor } from "@/server/access/policy";
import { aiSortingEnabled } from "@/server/care/ai-config";
import { listCareItems } from "@/server/care/care-items";
import { storedIntake } from "@/server/care/intake";
import { getOutsidePerson } from "@/server/care/outside-people";
import { cachedPerson } from "@/server/care/person-page";
import type { Proposal } from "@/server/care/proposals";
import type { createMatcher } from "@/server/care/reading-match";
import { getSalesforce } from "@/server/salesforce";
import type { Db } from "@/server/db/types";

/** Who a reading names: a Salesforce contact (read once a day) or an outside person. A failure leaves the person unmatched, never the page broken. */
async function personFrom(db: Db, actor: Actor, reading: Proposal["reading"], today: string): Promise<PersonChoice | null> {
  const named = reading?.person;
  try {
    if (named?.contactId) {
      const rec = await cachedPerson({ db, sf: getSalesforce, now: new Date() }, named.contactId, today);
      return rec ? { kind: "sf", contactId: rec.contactId, name: rec.name, household: rec.household } : null;
    }
    if (named?.outsidePersonId) {
      const o = await getOutsidePerson(db, actor, named.outsidePersonId);
      return { kind: "outside", id: o.id, name: o.name, note: o.note };
    }
  } catch {
    // Salesforce down, or a person this reader cannot see: leave it to the reader to pick.
  }
  return null;
}

export async function entryFor(db: Db, actor: Actor, p: Proposal, names: Map<string, string>, today: string, match: ReturnType<typeof createMatcher> | null): Promise<InboxEntry> {
  let person = await personFrom(db, actor, p.reading, today);
  let candidates: PersonChoice[] = (p.reading?.person?.candidates ?? []).map((c) => ({ kind: "sf", contactId: c.contactId, name: c.name, household: c.household }));
  // The app's AI reading only wrote down the names. Who they are is worked out here, for this viewer, through policy, and never stored.
  let nameMatches: InboxEntry["nameMatches"] = [];
  const wantsMatch = !person && candidates.length === 0 && !!p.reading?.names?.length;
  if (wantsMatch && match) {
    const found = await match(p.reading!.names!);
    nameMatches = found.map((m) => ({ name: m.name, state: m.state, chosenName: m.chosen?.name ?? null, candidateCount: m.candidates.length }));
    if (found[0]?.state === "one") person = found[0].chosen;
    else if (found[0]?.state === "ambiguous") candidates = found[0].candidates;
  }
  let existing: InboxEntry["existing"] = [];
  if (person) {
    try {
      const items = await listCareItems(db, actor, { status: "active", today, ...(person.kind === "sf" ? { sfContactId: person.contactId } : { outsidePersonId: person.id }) });
      existing = items.map((i) => ({ id: i.id, category: i.category }));
    } catch {
      existing = [];
    }
  }
  return { proposal: p, person, candidates, existing, nameMatches, matchPending: wantsMatch && !match, canReread: aiSortingEnabled() && !p.reading && !!p.rawText, suggestedOwnerName: p.reading?.ownerUserId ? (names.get(p.reading.ownerUserId) ?? null) : null, own: p.submittedBy === actor.id && p.reviewScope === "submitter", intake: storedIntake(p.intake) };
}
