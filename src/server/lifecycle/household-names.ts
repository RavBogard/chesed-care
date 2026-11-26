/**
 * Choosing who a meal page is for: a NAME-ONLY read of current-member households,
 * for the roles that run meal pages (staff and leads included). It returns a
 * person's name, their household's name and the two Ids, and selects nothing else:
 * no phone, address, date or Hebrew name. It reads Salesforce only, never this
 * app's care records or outside people, so a result says nothing about whether
 * anyone is in care. The search text is validated, escaped, never cached or logged.
 */
import { canSearchHouseholdNames, deny, type Actor } from "@/server/access/policy";
import { lookupContactIdField, NotFound } from "@/server/care/validate";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { soqlId } from "@/server/salesforce/ids";
import { obj, sfId, str } from "./fields";
import { escapeLike, FIND_LIMIT, searchWords } from "./find-people";

export type HouseholdName = { contactId: string; name: string; accountId: string | null; household: string | null };

const FIELDS = "Id, Name, AccountId, Account.Name, Account.npo02__Formal_Greeting__c, Account.npo02__Informal_Greeting__c";
const MEMBERS = "Account.cs_Member__c = true AND npsp__Deceased__c = false";

export function householdNamesQuery(words: string[]): string {
  const terms = words.map((w) => {
    const like = `'%${escapeLike(w)}%'`;
    return `(Name LIKE ${like} OR Account.Name LIKE ${like})`;
  });
  return `SELECT ${FIELDS} FROM Contact WHERE ${MEMBERS} AND ${terms.join(" AND ")} ORDER BY LastName ASC, FirstName ASC LIMIT ${FIND_LIMIT}`;
}

/** Built field by field, so nothing a fake or a future query returns can ride along. */
function nameOf(r: SfRow): HouseholdName[] {
  const id = sfId(r.Id);
  if (!id || !id.startsWith("003") || id.length !== 18) return [];
  const acct = obj(r.Account);
  return [{ contactId: id, name: str(r.Name) ?? "(unnamed)", accountId: sfId(r.AccountId), household: str(acct?.npo02__Formal_Greeting__c) ?? str(acct?.npo02__Informal_Greeting__c) ?? str(acct?.Name) }];
}

/** People in current-member households whose name (or household name) contains every word. Up to 25. */
export async function searchHouseholdNames(deps: { sf: () => SalesforceClient }, actor: Actor, query: unknown): Promise<HouseholdName[]> {
  if (!canSearchHouseholdNames(actor)) deny();
  const rows = await deps.sf().query(householdNamesQuery(searchWords(query)));
  return rows.slice(0, FIND_LIMIT).flatMap(nameOf);
}

/** The same four fields for one chosen Contact Id, read from Salesforce so a form cannot supply the name. NotFound: no such member. */
export async function resolveHouseholdName(deps: { sf: () => SalesforceClient }, actor: Actor, contactId: unknown): Promise<HouseholdName> {
  if (!canSearchHouseholdNames(actor)) deny();
  const [row] = await deps.sf().query(`SELECT ${FIELDS} FROM Contact WHERE Id = ${soqlId(lookupContactIdField(contactId), "Contact")} AND ${MEMBERS} LIMIT 1`);
  const [found] = row ? nameOf(row) : [];
  if (!found) throw new NotFound();
  return found;
}
