/**
 * Yahrzeits in a window, one row per observing current-member household.
 *
 * Date method (as MavenAI's maven_lifecycle): the yahrzeit date is the
 * Salesforce-recorded Yahrzeit__c.Next_English_Observance_Date__c (the next
 * civil-calendar observance the record computes), not a date computed here.
 * The observing households come from Yahrzeit_Observance__c, filtered to
 * Observer_Account__r.cs_Member__c = true.
 */
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { deathDateOf, deceasedHebrewName, deceasedName, hebrewDeathDateOf, hebrewDeathFields, householdFields, householdOf, obj, pickReach, reachFields, reachOf, sfId, str } from "./fields";
import type { Occasion } from "./types";
import { assertDateKey, roundedYears } from "./window";

export const OBSERVANCE_DATE = "Next_English_Observance_Date__c";
const CAP = 2000;

export function yahrzeitQuery(start: string, end: string): string {
  assertDateKey(start);
  assertDateKey(end);
  const y = "Yahrzeit__r.";
  return (
    `SELECT Id, Yahrzeit__c, Relationship__c, Observer_Account__c, ${householdFields("Observer_Account__r.")}, ` +
    `Contact__c, ${reachFields("Contact__r.")}, ` +
    `${y}Name, ${y}Deceased_Name__c, ${y}Deceased_First_Name__c, ${y}Deceased_Last_Name__c, ${y}Deceased_Hebrew_Name__c, ${y}Hebrew_Name__c, ` +
    `${y}English_Date_of_Death__c, ${y}Eng_Death_Date__c, ${hebrewDeathFields(y)}, ${y}${OBSERVANCE_DATE} ` +
    `FROM Yahrzeit_Observance__c ` +
    `WHERE ${y}${OBSERVANCE_DATE} >= ${start} AND ${y}${OBSERVANCE_DATE} <= ${end} AND Observer_Account__r.cs_Member__c = true ` +
    `ORDER BY ${y}${OBSERVANCE_DATE} ASC LIMIT ${CAP}`
  );
}

export function mapYahrzeits(rows: SfRow[]): Occasion[] {
  const seen = new Set<string>();
  const out: Occasion[] = [];
  for (const r of rows) {
    const y = obj(r.Yahrzeit__r);
    const yahrzeitId = sfId(r.Yahrzeit__c);
    const date = str(y?.[OBSERVANCE_DATE]);
    const h = householdOf(obj(r.Observer_Account__r), r.Observer_Account__c);
    if (!y || !yahrzeitId || !date || !h.isCurrentMember || !h.accountId) continue;
    const key = `${yahrzeitId}|${h.accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reach = pickReach(reachOf(r.Contact__c, obj(r.Contact__r)), h.primary);
    const deathDate = deathDateOf(y);
    out.push({
      type: "yahrzeit",
      date: date.slice(0, 10),
      subjectId: yahrzeitId,
      personName: deceasedName(y),
      personFirstName: str(y.Deceased_First_Name__c),
      hebrewName: deceasedHebrewName(y),
      hebrewDeathDate: hebrewDeathDateOf(y),
      household: h.household,
      informalGreeting: h.informalGreeting,
      accountId: h.accountId,
      ...reach,
      years: roundedYears(deathDate, date),
      relationship: str(r.Relationship__c),
      deathDate,
    });
  }
  return out;
}

export async function fetchYahrzeits(sf: SalesforceClient, start: string, end: string): Promise<Occasion[]> {
  return mapYahrzeits(await sf.query(yahrzeitQuery(start, end)));
}
