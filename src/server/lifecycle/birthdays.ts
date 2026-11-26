/**
 * Birthdays in a window for people in current-member households
 * (Account.cs_Member__c = true), never for a deceased contact. The person is
 * texted directly when they have a number, otherwise the household's primary contact.
 */
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { householdFields, householdOf, obj, pickReach, reachOf, sfId, str } from "./fields";
import type { Occasion } from "./types";
import { monthDayOrClause, windowHit, parseDate, type DayEntry } from "./window";

const CAP = 2000;

export function birthdayQuery(entries: DayEntry[]): string {
  return (
    `SELECT Id, Name, FirstName, Birthdate, MobilePhone, Phone, Hebrew_Name__c, AccountId, ${householdFields("Account.")} FROM Contact ` +
    `WHERE Birthdate != null AND npsp__Deceased__c = false AND Account.cs_Member__c = true ` +
    `AND (${monthDayOrClause("Birthdate", entries)}) LIMIT ${CAP}`
  );
}

export function mapBirthdays(rows: SfRow[], entries: DayEntry[]): Occasion[] {
  return rows.flatMap((r): Occasion[] => {
    const id = sfId(r.Id);
    const hit = windowHit(str(r.Birthdate), entries);
    const h = householdOf(obj(r.Account), r.AccountId);
    if (!id || !hit || !h.isCurrentMember) return [];
    const born = parseDate(str(r.Birthdate))!.year;
    const age = born > 1900 ? hit.year - born : null;
    return [
      {
        type: "birthday",
        date: hit.dateKey,
        subjectId: id,
        personName: str(r.Name) ?? "(unnamed)",
        personFirstName: str(r.FirstName),
        hebrewName: str(r.Hebrew_Name__c),
        hebrewDeathDate: null,
        household: h.household,
        informalGreeting: h.informalGreeting,
        accountId: h.accountId,
        ...pickReach(reachOf(r.Id, r), h.primary),
        years: age !== null && age >= 0 && age < 130 ? age : null,
        relationship: null,
        deathDate: null,
      },
    ];
  });
}

export async function fetchBirthdays(sf: SalesforceClient, entries: DayEntry[]): Promise<Occasion[]> {
  return mapBirthdays(await sf.query(birthdayQuery(entries)), entries);
}
