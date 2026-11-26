/**
 * Wedding anniversaries in a window for current-member households
 * (Account.cs_Member__c = true). The household's primary contact is texted.
 */
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { householdFields, householdOf, obj, sfId, str } from "./fields";
import type { Occasion } from "./types";
import { monthDayOrClause, parseDate, windowHit, type DayEntry } from "./window";

const CAP = 2000;
const MEMBERS_CAP = 12;
const HEBREW_LETTER = /\p{Script=Hebrew}/u;

/**
 * The Hebrew names of the couple, to face the household's name on the card. Salesforce does
 * not mark who the spouses are, so they are the household's living members whose first names
 * the household's greeting gives ("Michael and Deborah Cohen"); when that is not exactly two
 * people, nothing is shown. Names in Hebrew letters are preferred to names typed in Latin ones.
 */
export function coupleHebrewName(account: SfRow): string | null {
  const records = obj(account.Contacts)?.records;
  const members = Array.isArray(records) ? (records as SfRow[]) : [];
  const greeting = [account.npo02__Formal_Greeting__c, account.npo02__Informal_Greeting__c, account.Name]
    .map((v) => str(v) ?? "")
    .join(" | ")
    .toLowerCase();
  const words = greeting.split(/[^\p{L}\p{M}'’-]+/u).filter(Boolean);
  const place = (m: SfRow) => {
    const first = (str(m.FirstName) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return first.length > 0 && first.every((w) => words.includes(w)) ? words.indexOf(first[0]) : -1;
  };
  const couple = members.filter((m) => place(m) >= 0).sort((a, b) => place(a) - place(b));
  if (couple.length !== 2) return null;
  const names = couple.flatMap((m) => str(m.Hebrew_Name__c) ?? []);
  const lettered = names.filter((n) => HEBREW_LETTER.test(n));
  return (lettered.length ? lettered : names).join(" · ") || null;
}


export function anniversaryQuery(entries: DayEntry[]): string {
  return (
    `SELECT Id, Wedding_Date__c, ${householdFields("")}, ` +
    `(SELECT Id, FirstName, Hebrew_Name__c FROM Contacts WHERE npsp__Deceased__c = false LIMIT ${MEMBERS_CAP}) FROM Account ` +
    `WHERE Wedding_Date__c != null AND cs_Member__c = true AND (${monthDayOrClause("Wedding_Date__c", entries)}) LIMIT ${CAP}`
  );
}

export function mapAnniversaries(rows: SfRow[], entries: DayEntry[]): Occasion[] {
  return rows.flatMap((r): Occasion[] => {
    const id = sfId(r.Id);
    const wedding = str(r.Wedding_Date__c);
    const hit = windowHit(wedding, entries);
    const h = householdOf(r, r.Id);
    if (!id || !hit || !h.isCurrentMember) return [];
    const years = hit.year - parseDate(wedding)!.year;
    return [
      {
        type: "anniversary",
        date: hit.dateKey,
        subjectId: id,
        personName: h.household ?? "(household)",
        personFirstName: null,
        hebrewName: coupleHebrewName(r),
        hebrewDeathDate: null,
        household: h.household,
        informalGreeting: h.informalGreeting,
        accountId: h.accountId,
        ...h.primary,
        years: years > 0 && years <= 100 ? years : null,
        relationship: null,
        deathDate: null,
      },
    ];
  });
}

export async function fetchAnniversaries(sf: SalesforceClient, entries: DayEntry[]): Promise<Occasion[]> {
  return mapAnniversaries(await sf.query(anniversaryQuery(entries)), entries);
}
