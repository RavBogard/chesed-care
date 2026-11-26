/**
 * One person's Salesforce record for the person page: name, Hebrew name, household,
 * phone numbers, the household's members and the household's occasions in the coming
 * year. Read-only; no giving data. Occasions are listed only for current-member
 * households (Account.cs_Member__c = true), as everywhere else in the app.
 */
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { soqlId } from "@/server/salesforce/ids";
import { mapAnniversaries } from "./anniversaries";
import { mapBirthdays } from "./birthdays";
import type { Address } from "@/lib/address";
import { addressOf, billingFields, hebrewDeathFields, householdFields, householdOf, mailingFields, obj, reachFields, sfId, str } from "./fields";
import type { Occasion } from "./types";
import { addDays, assertDateKey, windowDays } from "./window";
import { mapYahrzeits, OBSERVANCE_DATE } from "./yahrzeits";

/** Occasions are shown this far ahead on the person page. */
export const PERSON_HORIZON_DAYS = 366;
const MEMBERS_CAP = 30;
const OBSERVANCES_CAP = 100;

export type Phone = { kind: "mobile" | "home" | "other"; number: string };
export type HouseholdMember = { contactId: string; name: string; hebrewName: string | null };

export type PersonRecord = {
  contactId: string;
  name: string;
  firstName: string | null;
  hebrewName: string | null;
  deceased: boolean;
  accountId: string | null;
  household: string | null;
  informalGreeting: string | null;
  isCurrentMember: boolean;
  phones: Phone[];
  /** The contact's mailing address, else the household's billing address. Null: Salesforce has none. */
  address: Address | null;
  members: HouseholdMember[];
  /** The household's yahrzeits, birthdays and anniversary from today through the horizon, by date. */
  occasions: Occasion[];
};

const PERSON_FIELDS = "Id, Name, FirstName, Hebrew_Name__c, MobilePhone, HomePhone, Phone, Birthdate, npsp__Deceased__c, AccountId";

export function personQueries(contactId: string, accountId: string | null, today: string) {
  assertDateKey(today);
  const end = addDays(today, PERSON_HORIZON_DAYS - 1);
  const person = `SELECT ${PERSON_FIELDS}, ${mailingFields("")}, Account.Wedding_Date__c, ${householdFields("Account.")}, ${billingFields("Account.")} FROM Contact WHERE Id = ${soqlId(contactId, "Contact")} LIMIT 1`;
  if (!accountId) return { person, members: null, observances: null };
  const acct = soqlId(accountId, "Account");
  const y = "Yahrzeit__r.";
  return {
    person,
    members:
      `SELECT ${PERSON_FIELDS}, ${householdFields("Account.")} FROM Contact ` +
      `WHERE AccountId = ${acct} AND npsp__Deceased__c = false ORDER BY Birthdate ASC NULLS LAST LIMIT ${MEMBERS_CAP}`,
    observances:
      `SELECT Id, Yahrzeit__c, Relationship__c, Observer_Account__c, ${householdFields("Observer_Account__r.")}, ` +
      `Contact__c, ${reachFields("Contact__r.")}, ` +
      `${y}Name, ${y}Deceased_Name__c, ${y}Deceased_First_Name__c, ${y}Deceased_Last_Name__c, ${y}Deceased_Hebrew_Name__c, ${y}Hebrew_Name__c, ` +
      `${y}English_Date_of_Death__c, ${y}Eng_Death_Date__c, ${hebrewDeathFields(y)}, ${y}${OBSERVANCE_DATE} FROM Yahrzeit_Observance__c ` +
      `WHERE Observer_Account__c = ${acct} AND ${y}${OBSERVANCE_DATE} >= ${today} AND ${y}${OBSERVANCE_DATE} <= ${end} ` +
      `ORDER BY ${y}${OBSERVANCE_DATE} ASC LIMIT ${OBSERVANCES_CAP}`,
  };
}

function phonesOf(r: SfRow): Phone[] {
  const out: Phone[] = [];
  const seen = new Set<string>();
  for (const [kind, v] of [
    ["mobile", r.MobilePhone],
    ["home", r.HomePhone],
    ["other", r.Phone],
  ] as const) {
    const n = str(v);
    const key = n?.replace(/\D/g, "");
    if (!n || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, number: n });
  }
  return out;
}

/** The person's record, or null when Salesforce has no such contact. */
export async function fetchPerson(sf: SalesforceClient, contactId: string, today: string): Promise<PersonRecord | null> {
  const [row] = await sf.query(personQueries(contactId, null, today).person);
  const id = sfId(row?.Id);
  if (!row || !id) return null;
  const acct = obj(row.Account);
  const h = householdOf(acct, row.AccountId);
  const q = personQueries(id, h.accountId, today);
  const [memberRows, observanceRows] = await Promise.all([q.members ? sf.query(q.members) : [], q.observances ? sf.query(q.observances) : []]);

  let occasions: Occasion[] = [];
  if (h.isCurrentMember && h.accountId) {
    const entries = windowDays(today, PERSON_HORIZON_DAYS);
    const birthdays = mapBirthdays(memberRows.filter((m) => str(m.Birthdate)), entries);
    const anniversary = str(acct?.Wedding_Date__c) ? mapAnniversaries([{ ...acct, Id: h.accountId, Contacts: { records: memberRows } }], entries) : [];
    occasions = [...mapYahrzeits(observanceRows), ...birthdays, ...anniversary].filter((o) => o.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  }

  return {
    contactId: id,
    name: str(row.Name) ?? "(unnamed)",
    firstName: str(row.FirstName),
    hebrewName: str(row.Hebrew_Name__c),
    deceased: row.npsp__Deceased__c === true,
    accountId: h.accountId,
    household: h.household,
    informalGreeting: h.informalGreeting,
    isCurrentMember: h.isCurrentMember,
    phones: phonesOf(row),
    address: addressOf(row, acct),
    members: memberRows.flatMap((m): HouseholdMember[] => {
      const mid = sfId(m.Id);
      return mid && mid !== id ? [{ contactId: mid, name: str(m.Name) ?? "(unnamed)", hebrewName: str(m.Hebrew_Name__c) }] : [];
    }),
    occasions,
  };
}
