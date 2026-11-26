/**
 * Everything on one person's page, for the acting user: the Salesforce record
 * (clergy level only; read once per Chicago day) and this app's care records,
 * redacted by the access policy. Salesforce being unreachable leaves the care
 * records intact and says so (salesforce: "unavailable").
 */
import { canManageOutsidePeople, canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import { CACHE_SHAPE, cachedForDay } from "@/server/cache/day-cache";
import type { Db } from "@/server/db/types";
import { fetchPerson, type PersonRecord } from "@/server/lifecycle/person";
import { chicagoToday } from "@/server/lifecycle/window";
import type { SalesforceClient } from "@/server/salesforce/client";
import { listCareItems, listCareItemStubs, type CareItem, type CareItemStub } from "./care-items";
import { listContactEntries, type ContactEntry } from "./contact-log";
import { listFollowUps, type FollowUp } from "./follow-ups";
import { listMarkKeys } from "./occasion-marks";
import { getOutsidePerson, type OutsidePerson } from "./outside-people";
import { listTeam, type TeamMember } from "./users";
import { InvalidInput, lookupContactIdField, NotFound } from "./validate";

export type PersonPage = {
  contactId: string;
  today: string;
  /** The best name known: Salesforce's, else the name cached on a care record. */
  name: string;
  accountId: string | null;
  /** ok: `person` is set. unavailable: Salesforce could not be read. hidden: the actor does not see Salesforce data. missing: no such contact. */
  salesforce: "ok" | "unavailable" | "hidden" | "missing";
  person: PersonRecord | null;
  /** markKey()s of the household's occasions already done this year. */
  doneMarks: string[];
  /** Care items the actor fully sees. */
  careItems: CareItem[];
  /** Restricted items in someone else's care: the person, the holder, nothing more. */
  restrictedCare: CareItemStub[];
  followUps: FollowUp[];
  contacts: ContactEntry[];
  team: TeamMember[];
};

/** The page of someone who is not in Salesforce: their own row and this app's care records. */
export type OutsidePersonPage = {
  outsidePersonId: string;
  today: string;
  name: string;
  person: OutsidePerson;
  careItems: CareItem[];
  restrictedCare: CareItemStub[];
  followUps: FollowUp[];
  contacts: ContactEntry[];
  team: TeamMember[];
};

export type PersonDeps = { db: Db; sf: () => SalesforceClient; now: Date };

/** Thrown when the requested Id resolves to a person under a different (canonical) Id: the caller redirects to it. */
export class CanonicalContactId extends Error {
  constructor(readonly contactId: string) {
    super("Redirect to the canonical Id");
    this.name = "CanonicalContactId";
  }
}

function contactIdOrNotFound(v: unknown): string {
  try {
    return lookupContactIdField(v);
  } catch (e) {
    if (e instanceof InvalidInput) throw new NotFound();
    throw e;
  }
}

/** The person from Salesforce, read at most once per Chicago day per Id. Null: no such contact. */
export async function cachedPerson(deps: PersonDeps, id: string, today: string): Promise<PersonRecord | null> {
  // Only canonical 18-character Ids are cached, so short-form lookups cannot fill the cache table.
  if (id.length !== 18) return fetchPerson(deps.sf(), id, today);
  const cached = await cachedForDay(deps.db, `person:${CACHE_SHAPE}:${id}`, today, async () => ({ record: await fetchPerson(deps.sf(), id, today) }));
  return cached.record;
}

export async function getPersonPage(deps: PersonDeps, actor: Actor, contactId: unknown): Promise<PersonPage> {
  const requested = contactIdOrNotFound(contactId);
  const { db } = deps;
  const today = chicagoToday(deps.now);

  let salesforce: PersonPage["salesforce"] = "hidden";
  let person: PersonRecord | null = null;
  if (canSeeLifecycle(actor)) {
    try {
      person = await cachedPerson(deps, requested, today);
      salesforce = person ? "ok" : "missing";
    } catch (error) {
      salesforce = "unavailable";
      console.error("Person page: Salesforce unavailable", error instanceof Error ? error.name : "unknown");
    }
  }
  // Only the canonical 18-character Id is ever a key. A 15-character or oddly cased Id that
  // Salesforce resolves is redirected to its canonical form; one it cannot resolve is not found.
  const id = person ? person.contactId : requested;
  if (id !== requested) throw new CanonicalContactId(id);
  if (id.length !== 18) throw new NotFound();

  const [careItems, restrictedCare, followUps, contacts, team] = await Promise.all([
    listCareItems(db, actor, { sfContactId: id }),
    listCareItemStubs(db, actor, { sfContactId: id }),
    listFollowUps(db, actor, { sfContactId: id }),
    listContactEntries(db, actor, { sfContactId: id, limit: 200 }),
    listTeam(db, actor),
  ]);
  let doneMarks: string[] = [];
  if (person?.occasions.length) {
    const years = person.occasions.map((o) => Number(o.date.slice(0, 4)));
    doneMarks = [...(await listMarkKeys(db, actor, years))];
  }

  const cachedName = careItems[0]?.displayName ?? followUps.find((f) => f.displayName)?.displayName ?? contacts[0]?.displayName ?? restrictedCare[0]?.displayName ?? null;
  // Nothing to show: no Salesforce record and no care record the actor may see.
  if (!person && !cachedName) {
    if (salesforce === "unavailable") return empty(id, today, "unavailable", team);
    throw new NotFound();
  }
  return {
    contactId: id,
    today,
    name: person?.name ?? cachedName!,
    accountId: person?.accountId ?? careItems[0]?.sfAccountId ?? contacts[0]?.sfAccountId ?? null,
    salesforce,
    person,
    doneMarks,
    careItems,
    restrictedCare,
    followUps,
    contacts,
    team,
  };
}

/** The same page for an outside person. Clergy level only; nothing is read from Salesforce. */
export async function getOutsidePersonPage(deps: { db: Db; now: Date }, actor: Actor, outsidePersonId: unknown): Promise<OutsidePersonPage> {
  if (!canManageOutsidePeople(actor)) deny();
  const { db } = deps;
  const person = await getOutsidePerson(db, actor, outsidePersonId);
  const [careItems, restrictedCare, followUps, contacts, team] = await Promise.all([
    listCareItems(db, actor, { outsidePersonId: person.id }),
    listCareItemStubs(db, actor, { outsidePersonId: person.id }),
    listFollowUps(db, actor, { outsidePersonId: person.id }),
    listContactEntries(db, actor, { outsidePersonId: person.id, limit: 200 }),
    listTeam(db, actor),
  ]);
  return { outsidePersonId: person.id, today: chicagoToday(deps.now), name: person.name, person, careItems, restrictedCare, followUps, contacts, team };
}

/** Salesforce is down and there are no care records: the page still renders, with no name. */
function empty(contactId: string, today: string, salesforce: "unavailable", team: TeamMember[]): PersonPage {
  return { contactId, today, name: "", accountId: null, salesforce, person: null, doneMarks: [], careItems: [], restrictedCare: [], followUps: [], contacts: [], team };
}
