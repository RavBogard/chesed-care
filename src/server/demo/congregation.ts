/**
 * Congregation Beit Dugma ("house of example"): the invented households the demo reads in
 * place of Salesforce. Nobody here is real. Every date is a number of days from today, so
 * the demo always has a birthday today and a yahrzeit this week. Phone numbers are in the
 * 555-01xx range, which is reserved for fiction. PURE data.
 */
export type DemoHousehold = {
  n: number;
  surname: string;
  formal: string;
  informal: string;
  street: string;
  /** The contact (by n) who is texted for the household. */
  primary: number;
  /** A wedding anniversary `inDays` from today, `years` years on. */
  wedding?: { inDays: number; years: number };
};

export type DemoContact = {
  n: number;
  household: number;
  first: string;
  last: string;
  hebrew?: string;
  mobile?: string;
  home?: string;
  /** A birthday `inDays` from today, turning `age`. */
  birthday?: { inDays: number; age: number };
  /** A baby born this many days ago. */
  bornDaysAgo?: number;
};

export type DemoYahrzeit = {
  n: number;
  first: string;
  last: string;
  hebrew?: string;
  /** A yahrzeit `inDays` from today, `years` years after the death. */
  observance?: { inDays: number; years: number };
  /** A recent death: died and buried this many days ago, from this household. */
  recent?: { diedDaysAgo: number; buriedDaysAgo: number; household: number };
  observers: { household: number; contact: number; relationship: string }[];
};

export const CITY = { city: "Riverton", state: "MO", postalCode: "63100" };

export const HOUSEHOLDS: DemoHousehold[] = [
  { n: 1, surname: "Rosen", formal: "Harold and Judith Rosen", informal: "Harold and Judith", street: "41 Elm Court", primary: 2, wedding: { inDays: 4, years: 48 } },
  { n: 2, surname: "Kaplan", formal: "Naomi Kaplan", informal: "Naomi", street: "22 Linden Way", primary: 3 },
  { n: 3, surname: "Stein", formal: "Rachel Kaplan-Stein and Michael Stein", informal: "Rachel and Michael", street: "9 Harbor Road", primary: 4 },
  { n: 4, surname: "Levy", formal: "Ben and Talia Levy", informal: "Ben and Talia", street: "117 Sycamore Street", primary: 9, wedding: { inDays: 11, years: 4 } },
  { n: 5, surname: "Friedman", formal: "Ruth Friedman", informal: "Ruth", street: "18 Alder Court", primary: 11 },
  { n: 6, surname: "Goldberg", formal: "Aaron Goldberg", informal: "Aaron", street: "305 Mill Lane", primary: 12 },
  { n: 7, surname: "Cohen-Ramirez", formal: "Sara Cohen and Luis Ramirez", informal: "Sara and Luis", street: "64 Orchard Avenue", primary: 13, wedding: { inDays: 2, years: 12 } },
  { n: 8, surname: "Shapiro", formal: "Ed Shapiro", informal: "Ed", street: "7 Birch Terrace", primary: 15 },
  { n: 9, surname: "Weiss-Nakamura", formal: "Hannah Weiss and Ken Nakamura", informal: "Hannah and Ken", street: "250 Prairie Street", primary: 16 },
  { n: 10, surname: "Mendel", formal: "Isaac and Bella Mendel", informal: "Isaac and Bella", street: "12 Willow Bend", primary: 20 },
  { n: 11, surname: "Abrams", formal: "Deborah Abrams", informal: "Deborah", street: "88 Chestnut Street", primary: 21 },
  { n: 12, surname: "Katz", formal: "Joel and Dina Katz", informal: "Joel and Dina", street: "31 Juniper Drive", primary: 22 },
  { n: 13, surname: "Blum", formal: "Sylvia Blum", informal: "Sylvia", street: "5 Cedar Close", primary: 25 },
  { n: 14, surname: "Green", formal: "Marcus and Leah Green", informal: "Marcus and Leah", street: "140 Meadow Road", primary: 26 },
];

export const CONTACTS: DemoContact[] = [
  { n: 1, household: 1, first: "Harold", last: "Rosen", hebrew: "צבי בן אברהם", mobile: "(555) 555-0101", birthday: { inDays: 40, age: 79 } },
  { n: 2, household: 1, first: "Judith", last: "Rosen", hebrew: "יהודית בת שרה", mobile: "(555) 555-0102", home: "(555) 555-0103", birthday: { inDays: 120, age: 76 } },
  { n: 3, household: 2, first: "Naomi", last: "Kaplan", hebrew: "נעמי בת רחל", mobile: "(555) 555-0104", birthday: { inDays: 200, age: 74 } },
  { n: 4, household: 3, first: "Rachel", last: "Kaplan-Stein", hebrew: "רחל בת דוד", mobile: "(555) 555-0105", birthday: { inDays: 6, age: 45 } },
  { n: 5, household: 3, first: "Michael", last: "Stein", mobile: "(555) 555-0106", birthday: { inDays: 88, age: 47 } },
  { n: 6, household: 3, first: "Eli", last: "Stein", hebrew: "אליהו בן מיכאל", birthday: { inDays: 1, age: 13 } },
  { n: 7, household: 3, first: "Maya", last: "Stein", birthday: { inDays: 150, age: 9 } },
  { n: 8, household: 4, first: "Ben", last: "Levy", hebrew: "בנימין בן יעקב", mobile: "(555) 555-0107", birthday: { inDays: 60, age: 34 } },
  { n: 9, household: 4, first: "Talia", last: "Levy", hebrew: "טליה בת מרים", mobile: "(555) 555-0108", birthday: { inDays: 230, age: 33 } },
  { n: 10, household: 4, first: "Noa", last: "Levy", bornDaysAgo: 9 },
  { n: 11, household: 5, first: "Ruth", last: "Friedman", hebrew: "רות בת חנה", home: "(555) 555-0109", birthday: { inDays: 0, age: 92 } },
  { n: 12, household: 6, first: "Aaron", last: "Goldberg", hebrew: "אהרן בן משה", mobile: "(555) 555-0110", birthday: { inDays: 75, age: 41 } },
  { n: 13, household: 7, first: "Sara", last: "Cohen", hebrew: "שרה בת לאה", mobile: "(555) 555-0111", birthday: { inDays: 3, age: 38 } },
  { n: 14, household: 7, first: "Luis", last: "Ramirez", mobile: "(555) 555-0112", birthday: { inDays: 170, age: 40 } },
  { n: 15, household: 8, first: "Ed", last: "Shapiro", hebrew: "אפרים בן יוסף", mobile: "(555) 555-0113", birthday: { inDays: 99, age: 81 } },
  { n: 16, household: 9, first: "Hannah", last: "Weiss", hebrew: "חנה בת רבקה", mobile: "(555) 555-0114", birthday: { inDays: 5, age: 58 } },
  { n: 17, household: 9, first: "Ken", last: "Nakamura", mobile: "(555) 555-0115", birthday: { inDays: 140, age: 60 } },
  { n: 18, household: 9, first: "Tamar", last: "Weiss-Nakamura", hebrew: "תמר בת חנה", mobile: "(555) 555-0116", birthday: { inDays: 210, age: 27 } },
  { n: 19, household: 10, first: "Isaac", last: "Mendel", hebrew: "יצחק בן שמואל", birthday: { inDays: 66, age: 84 } },
  { n: 20, household: 10, first: "Bella", last: "Mendel", hebrew: "בילה בת אסתר", mobile: "(555) 555-0117", home: "(555) 555-0118", birthday: { inDays: 180, age: 80 } },
  { n: 21, household: 11, first: "Deborah", last: "Abrams", hebrew: "דבורה בת מרים", mobile: "(555) 555-0119", birthday: { inDays: 250, age: 55 } },
  { n: 22, household: 12, first: "Joel", last: "Katz", hebrew: "יואל בן נתן", mobile: "(555) 555-0120", birthday: { inDays: 130, age: 49 } },
  { n: 23, household: 12, first: "Dina", last: "Katz", mobile: "(555) 555-0121", birthday: { inDays: 300, age: 46 } },
  { n: 24, household: 12, first: "Ari", last: "Katz", birthday: { inDays: 2, age: 16 } },
  { n: 25, household: 13, first: "Sylvia", last: "Blum", hebrew: "צביה בת פנינה", mobile: "(555) 555-0122", birthday: { inDays: 160, age: 78 } },
  { n: 26, household: 14, first: "Marcus", last: "Green", hebrew: "מרדכי בן שלמה", mobile: "(555) 555-0123", birthday: { inDays: 0, age: 50 } },
  { n: 27, household: 14, first: "Leah", last: "Green", hebrew: "לאה בת דינה", mobile: "(555) 555-0124", birthday: { inDays: 110, age: 48 } },
];

export const YAHRZEITS: DemoYahrzeit[] = [
  { n: 1, first: "Lillian", last: "Shapiro", hebrew: "לאה בת יעקב", observance: { inDays: 0, years: 6 }, observers: [{ household: 8, contact: 15, relationship: "Wife" }] },
  { n: 2, first: "Samuel", last: "Mendel", hebrew: "שמואל בן יצחק", observance: { inDays: 3, years: 31 }, observers: [{ household: 10, contact: 19, relationship: "Father" }] },
  { n: 3, first: "Nathan", last: "Katz", hebrew: "נתן בן אליעזר", observance: { inDays: 5, years: 9 }, observers: [{ household: 12, contact: 22, relationship: "Father" }] },
  { n: 4, first: "Miriam", last: "Abrams", hebrew: "מרים בת שרה", observance: { inDays: 1, years: 2 }, observers: [{ household: 11, contact: 21, relationship: "Mother" }] },
  { n: 5, first: "Rebecca", last: "Weiss", hebrew: "רבקה בת חיים", observance: { inDays: 9, years: 14 }, observers: [{ household: 9, contact: 16, relationship: "Mother" }] },
  { n: 6, first: "Abraham", last: "Rosen", hebrew: "אברהם בן צבי", observance: { inDays: 19, years: 40 }, observers: [{ household: 1, contact: 1, relationship: "Father" }] },
  {
    n: 7,
    first: "David",
    last: "Kaplan",
    hebrew: "דוד בן שמעון",
    recent: { diedDaysAgo: 3, buriedDaysAgo: 2, household: 2 },
    observers: [
      { household: 2, contact: 3, relationship: "Husband" },
      { household: 3, contact: 4, relationship: "Father" },
    ],
  },
  { n: 8, first: "Morris", last: "Blum", hebrew: "משה בן אריה", recent: { diedDaysAgo: 20, buriedDaysAgo: 19, household: 13 }, observers: [{ household: 13, contact: 25, relationship: "Husband" }] },
];

const id = (prefix: string, n: number) => `${prefix}DM${String(n).padStart(10, "0")}AAA`;
/** Salesforce-shaped Ids (18 characters) for the invented records. */
export const contactId = (n: number) => id("003", n);
export const accountId = (n: number) => id("001", n);
export const yahrzeitId = (n: number) => id("a0Y", n);

export const contactOf = (n: number) => CONTACTS.find((c) => c.n === n)!;
export const householdOf = (n: number) => HOUSEHOLDS.find((h) => h.n === n)!;
export const fullName = (c: DemoContact) => `${c.first} ${c.last}`;
