/**
 * "Brief me": one page of what is already known about a person, for clergy who may see
 * them. It is computed from the person page the actor already receives (so it shows exactly
 * what that page shows: items the actor fully sees, entries the actor may list, notes only
 * where the actor may read them), plus the meals, volunteer and Mi Sheberach lines, each read
 * through its own policy-checked list. No model is called, nothing new is stored, and there
 * is never any giving data. Gaps are said as gaps ("not known").
 */
import { CATEGORY_LABEL, statusLabel } from "@/lib/care-labels";
import { formatAddress, mapsUrl, type Address } from "@/lib/address";
import { canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import type { Db } from "@/server/db/types";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { mealsLineForPerson, type MealsLine } from "@/server/meals/person-line";
import { liveEntriesForCareItems, liveEntriesForPerson, type EntryView } from "@/server/misheberach/list";
import { listTasksForCareItems, type CareItemTask } from "@/server/volunteers/organiser";
import { outsideAddress } from "./outside-people";
import { getOutsidePersonPage, getPersonPage, type OutsidePersonPage, type PersonDeps, type PersonPage, CanonicalContactId } from "./person-page";
import { InvalidInput } from "./validate";

export type BriefAddress = { lines: string[]; oneLine: string; mapsUrl: string | null };

function briefAddress(a: Address | null): BriefAddress | null {
  if (!a) return null;
  const f = formatAddress(a);
  return f.lines.length ? { ...f, mapsUrl: mapsUrl(a) } : null;
}

export const BRIEF_CONTACTS = 3;
export const BRIEF_FOLLOW_UPS = 6;
export const BRIEF_DATES = 6;
export const NO_CONTACT_DAYS = 90;

export type Brief = {
  /** "contact" with a Salesforce id, or "outside". */
  who: { sfContactId: string | null; outsidePersonId: string | null };
  name: string;
  hebrewName: string | null;
  household: string | null;
  /** The address lines and a Google Maps link, for those who see phone numbers. Null: none on file. */
  address: BriefAddress | null;
  today: string;
  open: { itemId: string; category: string; status: string; since: string; heldBy: string | null }[];
  /** Restricted items in a colleague's care that the policy shows as a stub: only whose care. */
  restrictedElsewhere: { heldBy: string | null }[];
  contacts: { date: string; kind: string; outcome: string | null; by: string | null; note: string | null; noteHidden: boolean }[];
  upcoming: { title: string; due: string; heldBy: string | null; journeyStep: boolean }[];
  household_members: { contactId: string; name: string }[];
  dates: { date: string; type: string; personName: string; relationship: string | null }[];
  meals: { title: string; status: string; coveredThrough: string | null; openDates: number }[];
  volunteerTasks: { kind: string; forLabel: string; date: string; taken: number; peopleNeeded: number }[];
  miSheberach: { name: string; since: string; expiresOn: string | null }[];
  /** Plain sentences about what is not known. */
  notKnown: string[];
};

type Page = PersonPage | OutsidePersonPage;

async function safe<T>(op: () => Promise<T>): Promise<T | null> {
  try {
    return await op();
  } catch (error) {
    console.error("Brief: a line is unavailable", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

/** The brief for a page the actor has already been given. */
export async function buildBrief(db: Db, actor: Actor, page: Page, now: Date = new Date()): Promise<Brief> {
  if (!canSeeLifecycle(actor)) deny();
  const today = chicagoToday(now);
  const who = "contactId" in page ? { sfContactId: page.contactId, outsidePersonId: null } : { sfContactId: null, outsidePersonId: page.outsidePersonId };
  const salesforce = "contactId" in page ? page : null;
  const outsidePage = "contactId" in page ? null : page;
  const names = new Map(page.team.map((m) => [m.id, m.name ?? m.email]));
  const itemIds = page.careItems.map((i) => i.id);
  const accountId = salesforce?.accountId ?? null;

  const [meals, tasks, msPerson, msItems] = await Promise.all([
    safe<MealsLine[]>(() => mealsLineForPerson(db, actor, { sfContactId: who.sfContactId, sfAccountId: accountId, outsidePersonId: who.outsidePersonId }, now)),
    safe<CareItemTask[]>(() => listTasksForCareItems(db, actor, itemIds, now)),
    safe<EntryView[]>(() => liveEntriesForPerson(db, actor, who, now)),
    safe<EntryView[]>(() => liveEntriesForCareItems(db, actor, itemIds, now)),
  ]);

  const activeItems = page.careItems.filter((i) => i.status !== "closed");
  const open = activeItems.map((i) => ({
    itemId: i.id,
    category: CATEGORY_LABEL[i.category],
    status: statusLabel(i, today),
    since: chicagoToday(i.createdAt),
    heldBy: names.get(i.ownerUserId) ?? null,
  }));

  const contacts = page.contacts.slice(0, BRIEF_CONTACTS).map((c) => ({
    date: chicagoToday(c.occurredAt),
    kind: c.kind,
    outcome: c.outcome,
    by: c.authorName,
    note: c.noteHidden ? null : c.note,
    noteHidden: c.noteHidden,
  }));

  const upcoming = page.followUps
    .filter((f) => f.doneAt === null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, BRIEF_FOLLOW_UPS)
    .map((f) => ({ title: f.title, due: f.dueDate, heldBy: f.ownerUserId ? (names.get(f.ownerUserId) ?? null) : null, journeyStep: f.journeyId !== null }));

  const person = salesforce?.person ?? null;
  const dates = (person?.occasions ?? [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, BRIEF_DATES)
    .map((o) => ({ date: o.date, type: o.type, personName: o.personName, relationship: o.relationship }));

  const miRows = [...(msPerson ?? []), ...(msItems ?? [])].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);

  const notKnown: string[] = [];
  const lastContact = page.contacts[0]?.occurredAt ?? null;
  if (!lastContact) notKnown.push("No contact has been logged.");
  else if (chicagoToday(lastContact) < addDays(today, -NO_CONTACT_DAYS)) notKnown.push(`No contact has been logged in ${NO_CONTACT_DAYS} days. The last was ${chicagoToday(lastContact)}.`);
  for (const i of activeItems) {
    const holder = page.team.find((m) => m.id === i.ownerUserId);
    if (!holder || !holder.active) notKnown.push(`Nobody holds the ${CATEGORY_LABEL[i.category].toLowerCase()} item: its holder is no longer on the team.`);
  }
  if (activeItems.length > 0 && upcoming.length === 0) notKnown.push("Nothing is planned: no follow-up is set.");
  if (salesforce) {
    if (salesforce.salesforce === "unavailable") notKnown.push("Salesforce could not be read just now, so household and dates are missing.");
    else if (salesforce.salesforce === "missing") notKnown.push("This person was not found in Salesforce.");
    else if (person && person.phones.length === 0) notKnown.push("No phone number is on file.");
  } else {
    notKnown.push("This person is not in Salesforce: no household or dates are known.");
  }
  if (meals === null || tasks === null || msPerson === null || msItems === null) notKnown.push("Some lines (meals, volunteers or Mi Sheberach) could not be loaded just now.");

  return {
    who,
    name: page.name,
    hebrewName: person?.hebrewName ?? null,
    household: person?.household ?? null,
    address: briefAddress(salesforce ? (person?.address ?? null) : outsidePage ? outsideAddress(outsidePage.person) : null),
    today,
    open,
    restrictedElsewhere: page.restrictedCare.map((s) => ({ heldBy: s.ownerName })),
    contacts,
    upcoming,
    household_members: (person?.members ?? []).map((m) => ({ contactId: m.contactId, name: m.name })),
    dates,
    meals: (meals ?? []).map((m) => ({ title: m.title, status: m.status, coveredThrough: m.coveredThrough, openDates: m.openDates })),
    volunteerTasks: (tasks ?? []).filter((t) => t.status === "open" && t.date >= today).map((t) => ({ kind: t.kind, forLabel: t.forLabel, date: t.date, taken: t.taken, peopleNeeded: t.peopleNeeded })),
    miSheberach: miRows.map((e) => ({ name: e.name, since: e.dateAdded, expiresOn: e.expiresOn })),
    notKnown,
  };
}

/** The brief for a Salesforce contact (a short Id is followed to its canonical form) or an outside person. Exactly one must be given. */
export async function getBrief(deps: PersonDeps, actor: Actor, ref: { contactId?: unknown; outsidePersonId?: unknown }): Promise<Brief> {
  if (!canSeeLifecycle(actor)) deny();
  const hasContact = ref.contactId !== undefined && ref.contactId !== null && ref.contactId !== "";
  const hasOutside = ref.outsidePersonId !== undefined && ref.outsidePersonId !== null && ref.outsidePersonId !== "";
  if (hasContact === hasOutside) throw new InvalidInput("person");
  if (hasOutside) return buildBrief(deps.db, actor, await getOutsidePersonPage({ db: deps.db, now: deps.now }, actor, ref.outsidePersonId), deps.now);
  let page: PersonPage;
  try {
    page = await getPersonPage(deps, actor, ref.contactId);
  } catch (error) {
    if (!(error instanceof CanonicalContactId)) throw error;
    page = await getPersonPage(deps, actor, error.contactId);
  }
  return buildBrief(deps.db, actor, page, deps.now);
}
