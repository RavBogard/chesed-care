/**
 * Find a person: a read-only name search over people in current-member households
 * (Account.cs_Member__c = true), never a deceased contact. The search text is
 * validated, escaped for SOQL LIKE, never cached and never logged. The text arrives
 * by POST (a server action), never in a URL, so names stay out of access logs
 * and browser history.
 */
import { canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import { InvalidInput } from "@/server/care/validate";
import type { SalesforceClient } from "@/server/salesforce/client";
import { placeOf } from "@/lib/address";
import { addressOf, householdOf, obj, sfId, str } from "./fields";

export const FIND_LIMIT = 25;
const MIN = 2;
const MAX = 60;
const MAX_WORDS = 4;
/** Letters (any script), combining marks, spaces, apostrophes, hyphens and dots. */
const ALLOWED = /^[\p{L}\p{M}' .’-]+$/u;

export type PersonMatch = {
  contactId: string;
  name: string;
  firstName: string | null;
  hebrewName: string | null;
  accountId: string | null;
  household: string | null;
  /** City and state only (never a street), to tell two people with the same name apart. */
  place: string | null;
};

/** The search words, or InvalidInput("query"). */
export function searchWords(query: unknown): string[] {
  if (typeof query !== "string") throw new InvalidInput("query");
  const q = query.normalize("NFC").replace(/’/g, "'").replace(/\s+/g, " ").trim();
  if (q.length < MIN || q.length > MAX || !ALLOWED.test(q)) throw new InvalidInput("query");
  const words = q.split(" ").filter((w) => /[\p{L}]/u.test(w));
  if (!words.length || words.length > MAX_WORDS) throw new InvalidInput("query");
  return words;
}

/** A value for inside a quoted SOQL LIKE pattern: backslash, quote and the LIKE wildcards escaped. */
export function escapeLike(word: string): string {
  return word.replace(/[\\'%_]/g, (c) => `\\${c}`);
}

/** The furthest a search pages: 40 pages of 25. */
export const FIND_MAX_OFFSET = 975;

/** Whether "Load more" is offered after a page fetched at this offset: a full page, and a next page that is still allowed. */
export const canLoadMore = (capped: boolean, shown: number, offset: number) => capped && shown >= FIND_LIMIT && offset + FIND_LIMIT <= FIND_MAX_OFFSET;

export function findPeopleQuery(words: string[], offset = 0): string {
  if (!Number.isInteger(offset) || offset < 0 || offset > FIND_MAX_OFFSET || offset % FIND_LIMIT !== 0) throw new InvalidInput("offset");
  const terms = words.map((w) => {
    const like = `'%${escapeLike(w)}%'`;
    return `(Name LIKE ${like} OR Account.Name LIKE ${like})`;
  });
  return (
    `SELECT Id, Name, FirstName, Hebrew_Name__c, AccountId, Account.Name, Account.npo02__Formal_Greeting__c, Account.npo02__Informal_Greeting__c, Account.cs_Member__c, MailingCity, MailingState, Account.BillingCity, Account.BillingState ` +
    `FROM Contact WHERE Account.cs_Member__c = true AND npsp__Deceased__c = false AND ${terms.join(" AND ")} ` +
    `ORDER BY LastName ASC, FirstName ASC LIMIT ${FIND_LIMIT}${offset > 0 ? ` OFFSET ${offset}` : ""}`
  );
}

/** People in current-member households whose name (or household name) contains every word. */
export async function findPeople(deps: { sf: () => SalesforceClient }, actor: Actor, query: unknown): Promise<PersonMatch[]> {
  return (await findPeopleCapped(deps, actor, query)).people;
}

/** As findPeople, and whether Salesforce returned the full maximum (so the list may be incomplete). */
export async function findPeopleCapped(deps: { sf: () => SalesforceClient }, actor: Actor, query: unknown, offset = 0): Promise<{ people: PersonMatch[]; capped: boolean }> {
  if (!canSeeLifecycle(actor)) deny();
  const rows = await deps.sf().query(findPeopleQuery(searchWords(query), offset));
  const people = rows.slice(0, FIND_LIMIT).flatMap((r): PersonMatch[] => {
    const id = sfId(r.Id);
    const h = householdOf(obj(r.Account), r.AccountId);
    if (!id || !id.startsWith("003") || !h.isCurrentMember) return [];
    return [{ contactId: id, name: str(r.Name) ?? "(unnamed)", firstName: str(r.FirstName), hebrewName: str(r.Hebrew_Name__c), accountId: h.accountId, household: h.household, place: placeOf(addressOf(r, obj(r.Account))) }];
  });
  return { people, capped: rows.length >= FIND_LIMIT };
}
