/**
 * The demo's stand-in for Salesforce: it answers the app's own read-only queries from the
 * invented congregation (./congregation.ts) and reaches no network. It understands exactly
 * the queries src/server/lifecycle builds; tests/demo.test.ts runs every one of them through
 * it, so a new query shape fails there instead of quietly returning nothing.
 */
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { addDays, chicagoToday, parseDate } from "@/server/lifecycle/window";
import { accountId, CITY, contactId, CONTACTS, contactOf, fullName, householdOf, HOUSEHOLDS, yahrzeitId, YAHRZEITS, type DemoContact, type DemoHousehold, type DemoYahrzeit } from "./congregation";

/** The same month and day `years` earlier. */
function yearsBefore(day: string, years: number): string {
  const p = parseDate(day)!;
  return `${String(p.year - years).padStart(4, "0")}${day.slice(4)}`;
}

function reach(c: DemoContact): SfRow {
  return { Name: fullName(c), FirstName: c.first, MobilePhone: c.mobile ?? null, Phone: c.home ?? null, Hebrew_Name__c: c.hebrew ?? null };
}

function accountRow(h: DemoHousehold, today: string): SfRow {
  const wedding = h.wedding ? yearsBefore(addDays(today, h.wedding.inDays), h.wedding.years) : null;
  return {
    Id: accountId(h.n),
    Name: `${h.surname} Household`,
    npo02__Formal_Greeting__c: h.formal,
    npo02__Informal_Greeting__c: h.informal,
    cs_Member__c: true,
    npe01__One2OneContact__c: contactId(h.primary),
    npe01__One2OneContact__r: reach(contactOf(h.primary)),
    Wedding_Date__c: wedding,
    BillingStreet: h.street,
    BillingCity: CITY.city,
    BillingState: CITY.state,
    BillingPostalCode: CITY.postalCode,
  };
}

function birthdate(c: DemoContact, today: string): string | null {
  if (c.bornDaysAgo !== undefined) return addDays(today, -c.bornDaysAgo);
  return c.birthday ? yearsBefore(addDays(today, c.birthday.inDays), c.birthday.age) : null;
}

function contactRow(c: DemoContact, today: string): SfRow {
  return {
    Id: contactId(c.n),
    ...reach(c),
    LastName: c.last,
    HomePhone: c.home ?? null,
    Birthdate: birthdate(c, today),
    npsp__Deceased__c: false,
    AccountId: accountId(c.household),
    Account: accountRow(householdOf(c.household), today),
    MailingStreet: null,
    MailingCity: null,
    MailingState: null,
    MailingPostalCode: null,
  };
}

function deathDate(y: DemoYahrzeit, today: string): string {
  if (y.recent) return addDays(today, -y.recent.diedDaysAgo);
  // A yahrzeit drifts against the civil calendar; a few days off looks like the real thing.
  return addDays(yearsBefore(addDays(today, y.observance!.inDays), y.observance!.years), 4);
}

function yahrzeitRow(y: DemoYahrzeit, today: string): SfRow {
  const died = deathDate(y, today);
  const home = y.recent ? householdOf(y.recent.household) : null;
  return {
    Id: yahrzeitId(y.n),
    Name: `${y.first} ${y.last}`,
    Deceased_Name__c: `${y.first} ${y.last}`,
    Deceased_First_Name__c: y.first,
    Deceased_Last_Name__c: y.last,
    Deceased_Hebrew_Name__c: y.hebrew ?? null,
    English_Date_of_Death__c: died,
    Burial_Date__c: y.recent ? addDays(today, -y.recent.buriedDaysAgo) : null,
    Was_Member__c: true,
    Next_English_Observance_Date__c: y.observance ? addDays(today, y.observance.inDays) : addDays(died, 354),
    Deceased_Contact__c: null,
    Deceased_Contact__r: home ? { Deceased_Account__c: accountId(home.n), Deceased_Account__r: accountRow(home, today) } : null,
  };
}

function observanceRows(today: string, keep: (y: SfRow) => boolean): SfRow[] {
  return YAHRZEITS.flatMap((y) => {
    const row = yahrzeitRow(y, today);
    if (!keep(row)) return [];
    return y.observers.map((o, i) => ({
      Id: `a0ZDM${String(y.n * 10 + i).padStart(10, "0")}AAA`,
      Yahrzeit__c: row.Id,
      Yahrzeit__r: row,
      Relationship__c: o.relationship,
      Observer_Account__c: accountId(o.household),
      Observer_Account__r: accountRow(householdOf(o.household), today),
      Contact__c: contactId(o.contact),
      Contact__r: reach(contactOf(o.contact)),
    }));
  });
}

const between = (q: string, field: string): [string, string] | null => {
  const m = new RegExp(`${field} >= (\\d{4}-\\d{2}-\\d{2}) AND \\S*${field} <= (\\d{4}-\\d{2}-\\d{2})`).exec(q);
  return m ? [m[1], m[2]] : null;
};
const within = (value: unknown, range: [string, string]) => typeof value === "string" && value >= range[0] && value <= range[1];
const same15 = (a: unknown, b: string) => typeof a === "string" && a.slice(0, 15) === b.slice(0, 15);

/** The (month, day) pairs of a monthDayOrClause. */
function monthDays(q: string): Set<string> {
  return new Set([...q.matchAll(/CALENDAR_MONTH\([\w.]+\) = (\d+) AND DAY_IN_MONTH\([\w.]+\) = (\d+)/g)].map((m) => `${Number(m[1])}-${Number(m[2])}`));
}
const onOneOf = (date: unknown, days: Set<string>) => {
  const p = typeof date === "string" ? parseDate(date) : null;
  return !!p && days.has(`${p.month}-${p.day}`);
};

/** The words of a name search, unescaped from their LIKE patterns. */
function likeWords(q: string): string[] {
  return [...q.matchAll(/\(Name LIKE '%((?:\\.|[^'\\])*)%' OR/g)].map((m) => m[1].replace(/\\(.)/g, "$1").toLowerCase());
}

function answer(q: string, today: string): SfRow[] {
  const contacts = () => CONTACTS.map((c) => contactRow(c, today));
  if (q.includes("FROM pmdm__ServiceParticipant__c")) return [];
  if (q.includes("FROM Yahrzeit_Observance__c")) {
    const died = between(q, "English_Date_of_Death__c");
    if (died) return observanceRows(today, (y) => within(y.English_Date_of_Death__c, died));
    const window = between(q, "Next_English_Observance_Date__c");
    const account = /Observer_Account__c = '(\w+)'/.exec(q)?.[1];
    if (!window) return [];
    return observanceRows(today, (y) => within(y.Next_English_Observance_Date__c, window))
      .filter((o) => !account || same15(o.Observer_Account__c, account))
      .sort((a, b) => String((a.Yahrzeit__r as SfRow).Next_English_Observance_Date__c).localeCompare(String((b.Yahrzeit__r as SfRow).Next_English_Observance_Date__c)));
  }
  if (q.includes("FROM Account WHERE Wedding_Date__c")) {
    const days = monthDays(q);
    return HOUSEHOLDS.map((h) => accountRow(h, today))
      .filter((a) => onOneOf(a.Wedding_Date__c, days))
      .map((a) => ({ ...a, Contacts: { records: contacts().filter((c) => c.AccountId === a.Id) } }));
  }
  // Deaths recorded only on a Contact: the demo records every death as a yahrzeit.
  if (q.includes("FROM Contact WHERE Date_of_Death__c")) return [];
  if (q.includes("FROM Yahrzeit__c WHERE")) {
    const died = between(q, "English_Date_of_Death__c");
    return died ? YAHRZEITS.map((y) => yahrzeitRow(y, today)).filter((y) => within(y.English_Date_of_Death__c, died)) : [];
  }
  if (q.includes("FROM Contact WHERE")) {
    const one = /WHERE Id = '(\w+)'/.exec(q)?.[1];
    if (one) return contacts().filter((c) => same15(c.Id, one));
    const account = /WHERE AccountId = '(\w+)'/.exec(q)?.[1];
    if (account) return contacts().filter((c) => same15(c.AccountId, account)).sort((a, b) => String(a.Birthdate ?? "9").localeCompare(String(b.Birthdate ?? "9")));
    const born = between(q, "Birthdate");
    if (born) return contacts().filter((c) => within(c.Birthdate, born));
    if (q.includes("CALENDAR_MONTH(Birthdate)")) return contacts().filter((c) => onOneOf(c.Birthdate, monthDays(q)));
    const words = likeWords(q);
    if (words.length) {
      const offset = Number(/ OFFSET (\d+)/.exec(q)?.[1] ?? 0);
      const limit = Number(/ LIMIT (\d+)/.exec(q)?.[1] ?? 25);
      return contacts()
        .filter((c) => words.every((w) => `${String(c.Name)} | ${String((c.Account as SfRow).Name)}`.toLowerCase().includes(w)))
        .sort((a, b) => `${String(a.LastName)} ${String(a.FirstName)}`.localeCompare(`${String(b.LastName)} ${String(b.FirstName)}`))
        .slice(offset, offset + limit);
    }
  }
  throw new Error("The demo congregation does not understand this query");
}

/** A Salesforce that knows only Congregation Beit Dugma. Every query must still be a read. */
export function demoSalesforce(now: () => Date = () => new Date()): SalesforceClient {
  return {
    async query(soql) {
      return answer(assertReadOnlySoql(soql), chicagoToday(now()));
    },
  };
}
