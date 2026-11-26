import { describe, expect, it } from "vitest";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { sfDayCache } from "@/server/db/schema";
import { anniversaryQuery, coupleHebrewName, mapAnniversaries } from "@/server/lifecycle/anniversaries";
import { birthdayQuery, mapBirthdays } from "@/server/lifecycle/birthdays";
import { getOccasions } from "@/server/lifecycle/occasions";
import { collectDeaths, deathsToOccasions, enrollmentQueries, attachEnrollments, personNameKey, shloshimQueries, surnameWords } from "@/server/lifecycle/shloshim";
import { windowDays } from "@/server/lifecycle/window";
import { mapYahrzeits, yahrzeitQuery } from "@/server/lifecycle/yahrzeits";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { addActor, testDb } from "./support/db";

const ACC1 = "001000000000001AAA";
const ACC2 = "001000000000002AAA";
const C1 = "003000000000001AAA";
const C2 = "003000000000002AAA";
const Y1 = "a0B000000000001AAA";

const household = (over: Partial<SfRow> = {}): SfRow => ({
  Name: "Cohen Household",
  npo02__Formal_Greeting__c: "Ruth and Sam Cohen",
  npo02__Informal_Greeting__c: "Ruth and Sam",
  cs_Member__c: true,
  npe01__One2OneContact__c: C1,
  npe01__One2OneContact__r: { Name: "Ruth Cohen", FirstName: "Ruth", MobilePhone: "314-555-0101", Phone: null },
  ...over,
});

describe("current members only (Account.cs_Member__c = true)", () => {
  const w = windowDays("2026-11-23", 7);
  it("every lifecycle query filters on cs_Member__c = true", () => {
    expect(birthdayQuery(w)).toContain("Account.cs_Member__c = true");
    expect(anniversaryQuery(w)).toContain("cs_Member__c = true");
    expect(yahrzeitQuery("2026-11-23", "2026-11-29")).toContain("Observer_Account__r.cs_Member__c = true");
    const s = shloshimQueries("2026-11-23");
    expect(s.observances).toContain("Observer_Account__r.cs_Member__c = true");
    const enroll = enrollmentQueries(collectDeaths({ deaths: [{ Id: Y1, Deceased_Name__c: "Abe Cohen", Deceased_Last_Name__c: "Cohen", English_Date_of_Death__c: "2026-11-10" }], contactDeaths: [], observances: [] }, "2026-11-23"));
    expect(enroll[0]).toContain("Service_Participant_Account__r.cs_Member__c = true");
  });

  it("every query passes the read-only guard", () => {
    const s = shloshimQueries("2026-11-23");
    for (const q of [birthdayQuery(w), anniversaryQuery(w), yahrzeitQuery("2026-11-23", "2026-11-29"), s.deaths, s.contactDeaths, s.observances]) expect(() => assertReadOnlySoql(q)).not.toThrow();
  });

  it("rows from non-member households are dropped even if Salesforce returns them", () => {
    const rows = [{ Id: C1, Name: "Ruth Cohen", FirstName: "Ruth", Birthdate: "1986-11-23", AccountId: ACC1, Account: household({ cs_Member__c: false }) }];
    expect(mapBirthdays(rows, w)).toEqual([]);
    expect(mapAnniversaries([{ Id: ACC1, Wedding_Date__c: "1990-11-24", ...household({ cs_Member__c: false }) }], w)).toEqual([]);
  });

  it("refuses an injected window date", () => {
    expect(() => yahrzeitQuery("2026-11-23 OR Id != null", "2026-11-29")).toThrow();
    expect(() => shloshimQueries("x")).toThrow();
  });
});

describe("row mapping", () => {
  const w = windowDays("2026-11-23", 7);

  it("birthdays: person, Hebrew name, household, age, and their own mobile", () => {
    const [o] = mapBirthdays([{ Id: C2, Name: "Sam Cohen", FirstName: "Sam", Birthdate: "1980-11-25", MobilePhone: "314-555-0102", Hebrew_Name__c: "Shmuel", AccountId: ACC1, Account: household() }], w);
    expect(o).toMatchObject({ type: "birthday", date: "2026-11-25", subjectId: C2, personName: "Sam Cohen", hebrewName: "Shmuel", household: "Ruth and Sam Cohen", accountId: ACC1, contactId: C2, mobile: "314-555-0102", years: 46 });
  });

  it("birthdays: a child with no phone is reached through the household's primary contact", () => {
    const [o] = mapBirthdays([{ Id: C2, Name: "Lily Cohen", FirstName: "Lily", Birthdate: "2015-11-23", AccountId: ACC1, Account: household() }], w);
    expect(o).toMatchObject({ contactId: C1, contactName: "Ruth Cohen", mobile: "314-555-0101", years: 11 });
  });

  it("anniversaries: household greeting and years married", () => {
    const [o] = mapAnniversaries([{ Id: ACC1, Wedding_Date__c: "1990-11-24", ...household() }], w);
    expect(o).toMatchObject({ type: "anniversary", date: "2026-11-24", subjectId: ACC1, personName: "Ruth and Sam Cohen", informalGreeting: "Ruth and Sam", contactId: C1, years: 36 });
  });

  it("yahrzeits: one row per observing household, using the recorded next English observance date", () => {
    const row = (acct: string, contact: SfRow | null) => ({
      Yahrzeit__c: Y1,
      Relationship__c: "Father",
      Observer_Account__c: acct,
      Observer_Account__r: household(),
      Contact__c: contact ? C2 : null,
      Contact__r: contact,
      Yahrzeit__r: { Deceased_Name__c: "Abe Cohen", Deceased_First_Name__c: "Abe", Deceased_Hebrew_Name__c: "Avraham ben Yitzchak", English_Date_of_Death__c: "2016-12-01", Next_English_Observance_Date__c: "2026-11-26" },
    });
    const out = mapYahrzeits([row(ACC1, { Name: "Sam Cohen", FirstName: "Sam", MobilePhone: "314-555-0102" }), row(ACC1, null), row(ACC2, null)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "yahrzeit", date: "2026-11-26", subjectId: Y1, personName: "Abe Cohen", hebrewName: "Avraham ben Yitzchak", accountId: ACC1, contactName: "Sam Cohen", mobile: "314-555-0102", relationship: "Father", years: 10 });
    expect(out[1]).toMatchObject({ accountId: ACC2, contactName: "Ruth Cohen" });
  });

  it("yahrzeits: the Hebrew date of death comes from the recorded Hebrew date, else the civil date; the observer's Hebrew name comes along", () => {
    const row = (y: SfRow) => ({
      Yahrzeit__c: Y1,
      Observer_Account__c: ACC1,
      Observer_Account__r: household(),
      Contact__c: C2,
      Contact__r: { Name: "Sam Cohen", FirstName: "Sam", MobilePhone: "314-555-0102", Hebrew_Name__c: "שמואל" },
      Yahrzeit__r: { Deceased_Name__c: "Abe Cohen", Next_English_Observance_Date__c: "2026-11-26", ...y },
    });
    const [recorded] = mapYahrzeits([row({ Hebrew_Day__c: "10", Hebrew_Month__c: "Tevet", Hebrew_Year__c: "5787", Hebrew_Date_of_Death_In_Hebrew__c: "י׳ בְּטֵבֵת תשפ״ג", English_Date_of_Death__c: "2023-01-03" })]);
    expect(recorded).toMatchObject({ hebrewDeathDate: "י׳ בטבת תשפ״ג", contactHebrewName: "שמואל" });
    const [civil] = mapYahrzeits([row({ Hebrew_Month__c: "??", English_Date_of_Death__c: "2026-11-23" })]);
    expect(civil.hebrewDeathDate).toBe("י״ג בכסלו תשפ״ז");
    const [none] = mapYahrzeits([row({})]);
    expect(none.hebrewDeathDate).toBeNull();
    const q = yahrzeitQuery("2026-11-23", "2026-11-29");
    for (const field of ["Yahrzeit__r.Hebrew_Day__c", "Yahrzeit__r.Hebrew_Month__c", "Yahrzeit__r.Hebrew_Date_of_Death_In_Hebrew__c", "Contact__r.Hebrew_Name__c"]) expect(q).toContain(field);
    expect(q).not.toContain("Hebrew_Year__c");
  });

  it("anniversaries: the couple's Hebrew names face the household, only when the greeting names exactly those two", () => {
    const ruth = { Id: C1, FirstName: "Ruth", Hebrew_Name__c: "רות" };
    const sam = { Id: C2, FirstName: "Sam", Hebrew_Name__c: "שמואל" };
    const lily = { Id: "003000000000003AAA", FirstName: "Lily", Hebrew_Name__c: "לאה" };
    const acct = (members: SfRow[], over: Partial<SfRow> = {}) => ({ Id: ACC1, Wedding_Date__c: "1990-11-24", ...household(over), Contacts: { records: members } });
    // In the order the greeting gives them, and never a child the greeting does not name.
    expect(mapAnniversaries([acct([lily, sam, ruth])], w)[0].hebrewName).toBe("רות · שמואל");
    expect(coupleHebrewName(acct([ruth, { ...sam, Hebrew_Name__c: null }]))).toBe("רות");
    expect(coupleHebrewName(acct([ruth, { ...sam, Hebrew_Name__c: "Shmuel" }]))).toBe("רות");
    expect(coupleHebrewName(acct([{ ...ruth, Hebrew_Name__c: null }, { ...sam, Hebrew_Name__c: null }]))).toBeNull();
    // One named member, or three: not a couple we can be sure of.
    expect(coupleHebrewName(acct([ruth]))).toBeNull();
    expect(coupleHebrewName(acct([ruth, sam, lily], { npo02__Formal_Greeting__c: "Ruth, Sam and Lily Cohen" }))).toBeNull();
    expect(coupleHebrewName({ Id: ACC1, ...household() })).toBeNull();
    expect(anniversaryQuery(w)).toContain("Hebrew_Name__c FROM Contacts");
    expect(() => assertReadOnlySoql(anniversaryQuery(w))).not.toThrow();
  });

  it("drops rows whose Salesforce ids are malformed", () => {
    expect(mapYahrzeits([{ Yahrzeit__c: "bad'id", Observer_Account__c: ACC1, Observer_Account__r: household(), Yahrzeit__r: { Next_English_Observance_Date__c: "2026-11-26" } }])).toEqual([]);
  });
});

describe("shloshim", () => {
  const today = "2026-11-23";

  it("lists deaths until thirty days after burial (or death), one row per member mourner household", () => {
    const deaths = collectDeaths(
      {
        deaths: [
          { Id: Y1, Deceased_Name__c: "Abe Cohen", Deceased_Last_Name__c: "Cohen", English_Date_of_Death__c: "2026-10-20", Burial_Date__c: "2026-10-25", Deceased_Contact__r: { Deceased_Account__c: ACC1, Deceased_Account__r: household() } },
          // Shloshim over: died 2026-10-01, no burial date -> ended 2026-10-31.
          { Id: "a0B000000000002AAA", Deceased_Name__c: "Old Death", English_Date_of_Death__c: "2026-10-01" },
          // Future-dated rows are ignored.
          { Id: "a0B000000000003AAA", Deceased_Name__c: "Future", English_Date_of_Death__c: "2026-12-01" },
        ],
        contactDeaths: [],
        observances: [{ Yahrzeit__c: Y1, Relationship__c: "Son", Observer_Account__c: ACC2, Observer_Account__r: household({ npo02__Formal_Greeting__c: "Dan Cohen" }) }],
      },
      today,
    );
    expect(deaths.map((d) => d.subjectId)).toEqual([Y1]);
    expect(deaths[0].shloshimEnd).toBe("2026-11-24");
    const rows = deathsToOccasions(deaths);
    expect(rows.map((r) => [r.type, r.date, r.accountId, r.deathDate])).toEqual([
      ["shloshim", "2026-11-24", ACC2, "2026-10-20"],
      ["shloshim", "2026-11-24", ACC1, "2026-10-20"],
    ]);
  });

  it("a deceased member with no mourner on file is still listed, with no one to text", () => {
    const deaths = collectDeaths({ deaths: [{ Id: Y1, Deceased_Name__c: "Abe Cohen", English_Date_of_Death__c: "2026-11-20", Was_Member__c: true }], contactDeaths: [], observances: [] }, today);
    const [row] = deathsToOccasions(deaths);
    expect(row).toMatchObject({ personName: "Abe Cohen", accountId: null, mobile: null, date: "2026-12-20" });
  });

  it("finds mourners through yahrzeit-notification enrollments made after the death", () => {
    const deaths = collectDeaths({ deaths: [], contactDeaths: [{ Id: C2, Name: "Judith Ann Marlowe", LastName: "Marlowe", Date_of_Death__c: "2026-11-15" }], observances: [] }, today);
    const [q] = enrollmentQueries(deaths);
    expect(q).toContain("Deceased_Name__c LIKE '%Marlowe%'");
    expect(q).toContain("CreatedDate >= 2026-11-15T00:00:00Z");
    attachEnrollments(deaths, [
      { Deceased_Name__c: "Judith Marlowe", CreatedDate: "2026-11-16T10:00:00.000+0000", Service_Participant_Account__c: ACC2, Service_Participant_Account__r: household(), pmdm__Contact__c: C1, pmdm__Contact__r: { Name: "Ruth Cohen", FirstName: "Ruth", MobilePhone: "314-555-0101" } },
      // Enrolled before this death: an older namesake, not this family.
      { Deceased_Name__c: "Judith Marlowe", CreatedDate: "2019-01-01T00:00:00.000+0000", Service_Participant_Account__c: ACC1, Service_Participant_Account__r: household() },
    ]);
    expect(deathsToOccasions(deaths).map((r) => r.accountId)).toEqual([ACC2]);
  });

  it("only letters reach a LIKE clause", () => {
    expect(surnameWords("O'Brien-Smith")).toEqual(["Brien", "Smith"]);
    expect(surnameWords("x%' OR Name != '")).toEqual(["Name"]);
    for (const w of surnameWords("Dü%rr ' ; -- O'Neil \\' Smith")) expect(w).toMatch(/^\p{L}{3,}$/u);
    expect(personNameKey("Judith Ann Marlowe Jr.")).toBe("judith|marlowe");
  });
});

describe("getOccasions", () => {
  function fakeSf(byObject: Record<string, SfRow[]>) {
    const queries: string[] = [];
    const client: SalesforceClient = {
      async query(soql) {
        assertReadOnlySoql(soql);
        queries.push(soql);
        const from = /FROM (\w+)/.exec(soql.replace(/\(SELECT[^)]*\)/g, ""))![1];
        return byObject[from] ?? [];
      },
    };
    return { client, queries };
  }

  const data = {
    Contact: [
      { Id: C1, Name: "Ruth Cohen", FirstName: "Ruth", Birthdate: "1986-11-23", MobilePhone: "314-555-0101", AccountId: ACC1, Account: household() },
      { Id: C2, Name: "Sam Cohen", FirstName: "Sam", Birthdate: "1980-11-27", MobilePhone: "314-555-0102", AccountId: ACC1, Account: household() },
    ],
    Account: [{ Id: ACC1, Wedding_Date__c: "1990-11-29", ...household() }],
  };

  it("splits today from the rest of the week in Chicago time and caches per day", async () => {
    const db = await testDb();
    const actor = await addActor(db, "rabbi@crc.test", "owner");
    const sf = fakeSf(data);
    // 10pm in Chicago on Nov 23 (already Nov 24 in UTC).
    const now = new Date("2026-11-24T04:00:00Z");
    const view = await getOccasions({ db, sf: () => sf.client, now }, actor);
    expect(view.today).toBe("2026-11-23");
    expect(view.weekEnd).toBe("2026-11-29");
    expect(view.todays.map((o) => [o.type, o.personName])).toEqual([["birthday", "Ruth Cohen"]]);
    expect(view.week.map((o) => [o.type, o.date])).toEqual([
      ["birthday", "2026-11-27"],
      ["anniversary", "2026-11-29"],
    ]);
    const firstRun = sf.queries.length;
    expect(firstRun).toBeGreaterThan(0);

    // Same Chicago day: served from the day cache, no Salesforce reads.
    await getOccasions({ db, sf: () => sf.client, now: new Date("2026-11-24T05:30:00Z") }, actor);
    expect(sf.queries.length).toBe(firstRun);
    expect((await db.select().from(sfDayCache)).every((r) => r.day === "2026-11-23")).toBe(true);

    // Next Chicago day (just after midnight CST = 06:00Z): fresh reads.
    const next = await getOccasions({ db, sf: () => sf.client, now: new Date("2026-11-24T06:01:00Z") }, actor);
    expect(next.today).toBe("2026-11-24");
    expect(sf.queries.length).toBeGreaterThan(firstRun);
    expect(next.todays).toEqual([]);
  });

  it("does not cache a failed Salesforce read", async () => {
    const db = await testDb();
    const actor = await addActor(db, "rabbi@crc.test", "owner");
    const failing: SalesforceClient = { query: async () => Promise.reject(new Error("down")) };
    await expect(getOccasions({ db, sf: () => failing, now: new Date("2026-11-24T04:00:00Z") }, actor)).rejects.toThrow("down");
    expect(await db.select().from(sfDayCache)).toEqual([]);
  });

  it("is refused for caregivers", async () => {
    const db = await testDb();
    const carer: Actor = await addActor(db, "carer@crc.test", "caregiver");
    await expect(getOccasions({ db, sf: () => fakeSf({}).client, now: new Date() }, carer)).rejects.toBeInstanceOf(AccessDenied);
  });
});
