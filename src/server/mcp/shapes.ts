/**
 * Compact results for the connector: ids, names, dates and short fields. Phone
 * numbers appear only on occasion rows and the person page. Nothing here decides
 * access; every value arrives already filtered and redacted by the server
 * functions. PURE.
 */
import { formatAddress, mapsUrl, type Address } from "@/lib/address";
import type { CareItem, CareItemStub } from "@/server/care/care-items";
import type { ContactEntry } from "@/server/care/contact-log";
import type { FollowUp } from "@/server/care/follow-ups";
import { markKey } from "@/server/care/occasion-marks";
import type { Proposal } from "@/server/care/proposals";
import type { OwnDrafts } from "@/server/care/text-drafts";
import { draftFor, textableNumber } from "@/server/lifecycle/sms";
import type { Occasion } from "@/server/lifecycle/types";

export function occasionRow(o: Occasion, today: string, marks: ReadonlySet<string>, drafts: OwnDrafts) {
  const number = textableNumber(o);
  return {
    type: o.type,
    date: o.date,
    about: o.personName,
    hebrewName: o.hebrewName,
    years: o.years,
    ...(o.type === "yahrzeit" && o.years === 1 ? { firstYahrzeit: true } : {}),
    relationship: o.relationship,
    household: o.household,
    contactId: o.contactId,
    contactName: o.contactName,
    doneThisYear: marks.has(markKey({ occasionType: o.type, subjectId: o.subjectId, sfAccountId: o.accountId ?? "", year: Number(o.date.slice(0, 4)) })),
    // The person sends this themselves; nothing here sends a message.
    textNumber: number,
    textDraft: number ? draftFor(o, today, drafts) : null,
  };
}

export function followUpRow(f: FollowUp, actorId: string, today: string) {
  return {
    followUpId: f.id,
    title: f.title,
    dueDate: f.dueDate,
    overdue: !f.doneAt && f.dueDate < today,
    done: f.doneAt !== null,
    person: f.displayName,
    contactId: f.sfContactId,
    outsidePersonId: f.outsidePersonId,
    careItemId: f.careItemId,
    owner: f.ownerUserId === null ? "unassigned" : f.ownerUserId === actorId ? "me" : "someone else",
  };
}

/** The journeys running on a care item: each one's name and next step. */
export type JourneyLine = { journeyId: string; name: string; nextStep: { title: string; dueDate: string } | null };

export function careItemRow(i: CareItem, actorId: string, journeys?: JourneyLine[]) {
  return {
    ...(journeys ? { journeys } : {}),
    careItemId: i.id,
    person: i.displayName,
    contactId: i.sfContactId,
    outsidePersonId: i.outsidePersonId,
    category: i.category,
    // new: no contact yet. paused: set aside until pausedUntil, then it returns by itself.
    status: i.status,
    pausedUntil: i.pausedUntil,
    summary: i.summary,
    location: i.location,
    source: i.source,
    learnedFrom: i.learnedFrom,
    restricted: i.restricted,
    openedOn: i.createdAt.toISOString().slice(0, 10),
    mine: i.ownerUserId === actorId,
  };
}

/** A restricted item the person may know of but not read: who it is about and who holds it. There is nothing more to show. */
export function careItemStubRow(s: CareItemStub) {
  return { careItemId: s.id, person: s.displayName, contactId: s.sfContactId, outsidePersonId: s.outsidePersonId, restricted: true, inCareOf: s.ownerName };
}

/** A proposal waiting in the Inbox, with what was sent and the reading of it. */
export function proposalRow(p: Proposal) {
  return {
    proposalId: p.id,
    status: p.status,
    channel: p.channel,
    // True for text typed by an anonymous member of the public (the public form): nothing in it is verified or trusted.
    unverified: p.submittedBy === null && p.channel === "form",
    from: p.submitterName,
    // submitter: only the person who captured it reviews it. clergy: the shared Inbox.
    reviewScope: p.reviewScope,
    receivedAt: p.createdAt.toISOString(),
    text: p.rawText,
    reading: p.reading,
  };
}

/** A contact log entry as the access policy left it: a note the actor may not read is already null. */
export function contactRow(c: ContactEntry) {
  return {
    contactLogId: c.id,
    kind: c.kind,
    outcome: c.outcome,
    occurredAt: c.occurredAt.toISOString(),
    by: c.authorName,
    private: c.private,
    note: c.note,
    noteHidden: c.noteHidden,
  };
}

/** An address for the connector: the lines, the one-line form and the Google Maps link (null without a street). Only where phone numbers already appear. */
export function addressRow(a: Address | null) {
  if (!a) return null;
  const f = formatAddress(a);
  return f.lines.length ? { lines: f.lines, oneLine: f.oneLine, mapsUrl: mapsUrl(a) } : null;
}
