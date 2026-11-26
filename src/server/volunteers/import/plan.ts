/**
 * What the import will do to the roster, decided before anything is written. Pure: the roster rows and the contacts
 * of people who stopped are passed in. A merged person is matched to a roster row, in this order:
 *
 *  1. A contact of someone who asked to stop: "skipped: left/opted out".
 *  2. A row carrying one of their row fingerprints (an earlier run made or linked it).
 *  3. Exactly one row with a shared contact AND the same first name.
 *  Anything looser (a contact with another first name, a name alone, more than one row) is "skipped: ambiguous" and
 *  listed by tab and row: never linked, so the sheet's history is never attached to someone on a guess.
 *  Any match, firm or loose, to someone who left or stopped is "skipped: left/opted out": they are never re-added or
 *  re-activated.
 *
 * Then: a row an earlier run made, which no person has edited since (its fields still hash to what the import wrote),
 * is brought up to date. One a person edited keeps every field they can edit; only the import's own fields (sources,
 * history, details, fingerprints) are added to. A member who joined another way keeps everything and is not marked
 * imported. Every new person is "imported, not yet asked": emails_held set, no consent recorded.
 */
import { createHash, randomUUID } from "node:crypto";
import { corpsMembers, type CorpsImportDetails } from "@/server/db/schema";
import { LIMITS, fit, phoneKey } from "./cells";
import { firstSeen, matchOf, type Identity } from "./merge";
import type { MergedPerson } from "./types";

export type Member = typeof corpsMembers.$inferSelect;
type Insert = typeof corpsMembers.$inferInsert;
export type ImportOwned = Pick<Insert, "importSources" | "importHistory" | "importDetails" | "importFingerprints">;

export type PlanItem =
  | { action: "new"; values: Insert & { id: string } }
  /** `was`: the import_hash the row had when read; the write only lands if it still has it. */
  | { action: "update"; id: string; was: string | null; set: Partial<Insert> }
  | { action: "kept_edited"; id: string; was: string | null; set: ImportOwned | null }
  | { action: "linked"; id: string; was: string | null; set: ImportOwned | null }
  | { action: "unchanged"; id: string }
  | { action: "skipped_left" }
  | { action: "skipped_ambiguous" }
  /** Shares an email or phone with someone on the roster under another first name: not linked, not added. */
  | { action: "skipped_contact_clash" };

/** `sharedContacts`: people added or updated with a contact someone else already holds, kept only as their "other" contact. */
export type Plan = { items: { person: MergedPerson; item: PlanItem }[]; sharedContacts: number };

/** The fields a person can change in the app. A row whose values no longer hash to what the import wrote was edited. */
const EDITABLE = ["firstName", "lastName", "email", "emailKey", "mobile", "mobileKey", "canDo", "availability", "area", "howOften", "preferContact", "coordinatorNotes", "status", "pausedUntil"] as const;
type Editable = Pick<Member, (typeof EDITABLE)[number]>;

export function editableHash(row: Editable): string {
  const v = EDITABLE.map((k) => (k === "canDo" ? [...row.canDo].sort() : (row[k] ?? null)));
  return createHash("sha256").update(JSON.stringify(v)).digest("base64url");
}

const identityOf = (m: Member): Identity => ({
  firstName: m.firstName,
  lastName: m.lastName,
  emails: [m.emailKey, ...(m.importDetails?.otherEmails ?? [])].filter((x): x is string => !!x),
  phones: [m.mobileKey, ...(m.importDetails?.otherPhones ?? []).map(phoneKey)].filter((x): x is string => !!x),
});

const isGone = (m: Member) => m.status === "left" || m.stoppedBy !== null || m.contactPurgedAt !== null;

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const line = (s: string) => s.slice(0, LIMITS.line);
const compact = (d: CorpsImportDetails): CorpsImportDetails =>
  Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))) as CorpsImportDetails;

/** The import's own fields, added to what the row already holds: nothing is dropped. `extraNotes`: whole values cut to fit a column. */
function ownFields(p: MergedPerson, otherEmails: string[], otherPhones: string[], have?: Member, extraNotes: string[] = []): ImportOwned {
  const old = have?.importDetails ?? {};
  const details = compact({
    otherEmails: uniq([...(old.otherEmails ?? []), ...otherEmails]),
    otherPhones: uniq([...(old.otherPhones ?? []), ...otherPhones]),
    address: p.address ? line(p.address) : (old.address ?? null),
    city: p.city ? line(p.city) : (old.city ?? null),
    zip: p.zip ? line(p.zip) : (old.zip ?? null),
    offers: uniq([...(old.offers ?? []), ...p.offers.map(line)]),
    frequency: p.frequency ? line(p.frequency) : (old.frequency ?? null),
    notes: uniq([...(old.notes ?? []), ...p.notes.map(line), ...extraNotes]),
    markers: uniq([...(old.markers ?? []), ...p.markers]),
    okToText: p.okToText ?? old.okToText ?? null,
    coordinatorInterest: p.coordinatorInterest ?? old.coordinatorInterest ?? null,
    formAt: [p.formAt, old.formAt].filter((x): x is string => !!x).sort().at(-1) ?? null,
  });
  const history = uniq([...(have?.importHistory ? have.importHistory.split("\n") : []), ...p.history.map(line)]).filter(Boolean);
  return {
    importSources: uniq([...(have?.importSources ?? []), ...p.sources]),
    importHistory: history.length ? history.join("\n") : null,
    importDetails: details,
    importFingerprints: uniq([...(have?.importFingerprints ?? []), ...p.fingerprints]),
  };
}

// Postgres hands jsonb back with its keys in its own order, so objects are compared with their keys sorted.
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : (v ?? null);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const changedOwn = (have: Member, own: ImportOwned) => !sameJson(have.importSources, own.importSources) || have.importHistory !== own.importHistory || !sameJson(have.importDetails, own.importDetails) || !sameJson(have.importFingerprints, own.importFingerprints);

/** The person's names and area, cut to the app's limits; a cut value is kept whole in the notes. */
function fitted(p: MergedPerson) {
  const extra: string[] = [];
  const firstName = fit(p.firstName, LIMITS.firstName, (w) => extra.push(`First name in full: ${w}`)) ?? "";
  const lastName = fit(p.lastName, LIMITS.lastName, (w) => extra.push(`Last name in full: ${w}`));
  const area = fit(p.zip ?? p.city, LIMITS.area, (w) => extra.push(`Area in full: ${w}`));
  return { firstName, lastName, area, extra };
}

type Found = { kind: "left" } | { kind: "ambiguous" } | { kind: "clash" } | { kind: "none" } | { kind: "row"; row: Member };

const sharesAContact = (p: MergedPerson, m: Member) => {
  const id = identityOf(m);
  return p.emails.some((e) => id.emails.includes(e)) || p.phones.some((x) => id.phones.includes(phoneKey(x)));
};

function findRow(p: MergedPerson, roster: Member[], stoppedKeys: ReadonlySet<string>, claimed: Set<string>): Found {
  if ([...p.emails, ...p.phones.map(phoneKey)].some((k) => stoppedKeys.has(k))) return { kind: "left" };
  const byPrint = roster.filter((m) => (m.importFingerprints ?? []).some((f) => p.fingerprints.includes(f)));
  if (byPrint.some(isGone)) return { kind: "left" };
  if (byPrint.length > 1) return { kind: "ambiguous" };
  if (byPrint.length === 1) return claimed.has(byPrint[0].id) ? { kind: "ambiguous" } : { kind: "row", row: byPrint[0] };
  const matches = roster.map((m) => ({ m, how: matchOf(p, identityOf(m)) })).filter((x) => x.how !== null);
  if (matches.some((x) => isGone(x.m))) return { kind: "left" };
  const exact = matches.filter((x) => x.how === "exact");
  if (exact.length === 1 && !claimed.has(exact[0].m.id)) return { kind: "row", row: exact[0].m };
  if (matches.length === 0) return { kind: "none" };
  // No firm match: a contact someone else on the roster holds under another first name is a clash; a name alone, ambiguous.
  return exact.length === 0 && matches.some((x) => sharesAContact(p, x.m)) ? { kind: "clash" } : { kind: "ambiguous" };
}

export function planImport(people: MergedPerson[], roster: Member[], stoppedKeys: ReadonlySet<string>, now: Date, today: string): Plan {
  // Contact keys already held, by whom: a key goes on a row only when nobody else holds it.
  const holder = new Map<string, string>();
  for (const m of roster) {
    if (m.emailKey) holder.set(`e:${m.emailKey}`, m.id);
    if (m.mobileKey) holder.set(`m:${m.mobileKey}`, m.id);
  }
  const claimed = new Set<string>();
  const items: Plan["items"] = [];
  let sharedContacts = 0;

  const pick = (values: string[], kind: "e" | "m", self: string) => {
    const key = (v: string) => (kind === "e" ? v : phoneKey(v));
    const ok = (v: string) => (holder.get(`${kind}:${key(v)}`) ?? self) === self && v.length <= (kind === "e" ? LIMITS.email : LIMITS.mobile);
    const main = values.find(ok) ?? null;
    if (main) holder.set(`${kind}:${key(main)}`, self);
    clash ||= values.some((v) => (holder.get(`${kind}:${key(v)}`) ?? self) !== self);
    return { main, mainKey: main ? key(main) : null, others: values.filter((v) => v !== main) };
  };

  let clash = false;
  for (const p of people) {
    if (clash) sharedContacts++;
    clash = false;
    const found = findRow(p, roster, stoppedKeys, claimed);
    if (found.kind === "left") {
      items.push({ person: p, item: { action: "skipped_left" } });
      continue;
    }
    if (found.kind === "ambiguous" || found.kind === "clash") {
      items.push({ person: p, item: { action: found.kind === "clash" ? "skipped_contact_clash" : "skipped_ambiguous" } });
      continue;
    }
    const f = fitted(p);
    if (found.kind === "none") {
      const id = randomUUID();
      const e = pick(p.emails, "e", id);
      const m = pick(p.phones, "m", id);
      const values = {
        id,
        firstName: f.firstName,
        lastName: f.lastName,
        email: e.main,
        emailKey: e.mainKey,
        mobile: m.main,
        mobileKey: m.mainKey,
        canDo: p.canDo,
        availability: null,
        area: f.area,
        howOften: p.howOften,
        preferContact: null,
        coordinatorNotes: null,
        status: "active" as const,
        pausedUntil: null,
        source: "import" as const,
        joinedOn: firstSeen(p) ?? today,
        consentAt: null,
        importedAt: now,
        emailsHeld: true,
        notVolunteered: p.notVolunteered,
        ...ownFields(p, e.others, m.others, undefined, f.extra),
      };
      items.push({ person: p, item: { action: "new", values: { ...values, importHash: editableHash(values) } } });
      continue;
    }
    const have = found.row;
    claimed.add(have.id);
    const others = () => ownFields(p, p.emails.filter((x) => x !== have.emailKey), p.phones.filter((x) => phoneKey(x) !== have.mobileKey), have, f.extra);
    if (have.importedAt === null || have.importHash === null) {
      const own = others();
      items.push({ person: p, item: { action: "linked", id: have.id, was: have.importHash, set: changedOwn(have, own) ? own : null } });
      continue;
    }
    if (editableHash(have) !== have.importHash) {
      const own = others();
      items.push({ person: p, item: { action: "kept_edited", id: have.id, was: have.importHash, set: changedOwn(have, own) ? own : null } });
      continue;
    }
    const e = pick(p.emails, "e", have.id);
    const m = pick(p.phones, "m", have.id);
    const editable: Editable = { firstName: f.firstName || have.firstName, lastName: f.lastName, email: e.main, emailKey: e.mainKey, mobile: m.main, mobileKey: m.mainKey, canDo: p.canDo, availability: have.availability, area: f.area, howOften: p.howOften, preferContact: have.preferContact, coordinatorNotes: have.coordinatorNotes, status: have.status, pausedUntil: have.pausedUntil };
    const own = ownFields(p, e.others, m.others, have, f.extra);
    if (editableHash(editable) === have.importHash && !changedOwn(have, own)) {
      items.push({ person: p, item: { action: "unchanged", id: have.id } });
      continue;
    }
    items.push({ person: p, item: { action: "update", id: have.id, was: have.importHash, set: { ...editable, ...own, importHash: editableHash(editable), notVolunteered: have.notVolunteered && p.notVolunteered } } });
  }
  if (clash) sharedContacts++;
  return { items, sharedContacts };
}
