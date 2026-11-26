import { describe, expect, it } from "vitest";
import { createCareItem } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp } from "@/server/care/follow-ups";
import { markOccasion, markKey } from "@/server/care/occasion-marks";
import { getPersonPage } from "@/server/care/person-page";
import { NotFound } from "@/server/care/validate";
import { personQueries } from "@/server/lifecycle/person";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { ACCOUNT, CONTACT, CONTACT2, team, testDb } from "./support/db";

const Y1 = "a0B000000000001AAA";
// 10am Chicago, Nov 23 2026.
const NOW = new Date("2026-11-23T16:00:00Z");

const household = (over: Partial<SfRow> = {}): SfRow => ({
  Name: "Cohen Household",
  npo02__Formal_Greeting__c: "Ruth and Sam Cohen",
  npo02__Informal_Greeting__c: "Ruth and Sam",
  cs_Member__c: true,
  npe01__One2OneContact__c: CONTACT,
  npe01__One2OneContact__r: { Name: "Ruth Cohen", FirstName: "Ruth", MobilePhone: "314-555-0101" },
  Wedding_Date__c: "1990-12-02",
  ...over,
});

function fakeSf(opts: { member?: boolean; fail?: boolean } = {}) {
  const queries: string[] = [];
  const acct = household({ cs_Member__c: opts.member ?? true });
  const client: SalesforceClient = {
    async query(soql) {
      queries.push(assertReadOnlySoql(soql));
      if (opts.fail) throw new Error("down");
      if (soql.includes("FROM Yahrzeit_Observance__c"))
        return [
          {
            Yahrzeit__c: Y1,
            Observer_Account__c: ACCOUNT,
            Observer_Account__r: acct,
            Relationship__c: "Father",
            Yahrzeit__r: { Deceased_Name__c: "Abe Cohen", English_Date_of_Death__c: "2016-12-01", Next_English_Observance_Date__c: "2026-12-10" },
          },
        ];
      if (soql.includes(`WHERE Id = '${CONTACT}'`))
        return [{ Id: CONTACT, Name: "Ruth Cohen", FirstName: "Ruth", Hebrew_Name__c: "רות", MobilePhone: "(314) 555-0101", HomePhone: "314.555.0101", Phone: "314-555-0199", Birthdate: "1986-11-25", npsp__Deceased__c: false, AccountId: ACCOUNT, Account: acct }];
      if (soql.includes("WHERE AccountId"))
        return [
          { Id: CONTACT, Name: "Ruth Cohen", FirstName: "Ruth", Birthdate: "1986-11-25", AccountId: ACCOUNT, Account: acct },
          { Id: CONTACT2, Name: "Sam Cohen", FirstName: "Sam", Birthdate: "1980-01-05", Hebrew_Name__c: "שמואל", AccountId: ACCOUNT, Account: acct },
        ];
      return [];
    },
  };
  return { client, queries };
}

describe("getPersonPage", () => {
  it("queries are read-only and pinned to the one contact and household", () => {
    const q = personQueries(CONTACT, ACCOUNT, "2026-11-23");
    for (const s of [q.person, q.members!, q.observances!]) expect(() => assertReadOnlySoql(s)).not.toThrow();
    expect(q.person).toContain(`WHERE Id = '${CONTACT}'`);
    expect(q.members).toContain(`AccountId = '${ACCOUNT}'`);
    expect(() => personQueries("003' OR Id != '", null, "2026-11-23")).toThrow();
  });

  it("assembles the Salesforce record, household occasions and care records, cached for the day", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call after surgery", dueDate: "2026-11-24" });
    await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "visit", occurredAt: "2026-11-20T15:00:00Z", note: "Brought soup" });
    await markOccasion(db, t.owner, { occasionType: "birthday", subjectId: CONTACT, sfAccountId: ACCOUNT, year: 2026 });

    const sf = fakeSf();
    const page = await getPersonPage({ db, sf: () => sf.client, now: NOW }, t.owner, CONTACT);
    expect(page).toMatchObject({ contactId: CONTACT, name: "Ruth Cohen", accountId: ACCOUNT, salesforce: "ok", today: "2026-11-23" });
    expect(page.person!.hebrewName).toBe("רות");
    expect(page.person!.household).toBe("Ruth and Sam Cohen");
    // Duplicate numbers (formatting aside) are listed once.
    expect(page.person!.phones.map((p) => p.kind)).toEqual(["mobile", "other"]);
    expect(page.person!.members.map((m) => m.contactId)).toEqual([CONTACT2]);
    expect(page.person!.occasions.map((o) => [o.type, o.date])).toEqual([
      ["birthday", "2026-11-25"],
      ["anniversary", "2026-12-02"],
      ["yahrzeit", "2026-12-10"],
      ["birthday", "2027-01-05"],
    ]);
    expect(page.doneMarks).toContain(markKey({ occasionType: "birthday", subjectId: CONTACT, sfAccountId: ACCOUNT, year: 2026 }));
    expect(page.careItems.map((i) => i.id)).toEqual([item.id]);
    expect(page.followUps.map((f) => f.title)).toEqual(["Call after surgery"]);
    expect(page.contacts[0].note).toBe("Brought soup");

    const reads = sf.queries.length;
    await getPersonPage({ db, sf: () => sf.client, now: NOW }, t.clergy, CONTACT);
    expect(sf.queries.length).toBe(reads);
  });

  it("a private note shows its text only to the author; others see that it happened", async () => {
    const db = await testDb();
    const t = await team(db);
    await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", kind: "call", occurredAt: "2026-11-20T15:00:00Z", note: "Private words", private: true });
    const sf = fakeSf();
    const mine = await getPersonPage({ db, sf: () => sf.client, now: NOW }, t.clergy, CONTACT);
    const theirs = await getPersonPage({ db, sf: () => sf.client, now: NOW }, t.clergy2, CONTACT);
    expect(mine.contacts[0]).toMatchObject({ note: "Private words", noteHidden: false });
    expect(theirs.contacts[0]).toMatchObject({ note: null, noteHidden: true, kind: "call" });
    expect(JSON.stringify(theirs)).not.toContain("Private words");
  });

  it("Salesforce unreachable: care records still load and the page says dates are unavailable", async () => {
    const db = await testDb();
    const t = await team(db);
    await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    const page = await getPersonPage({ db, sf: () => fakeSf({ fail: true }).client, now: NOW }, t.clergy, CONTACT);
    expect(page).toMatchObject({ salesforce: "unavailable", person: null, name: "Ruth Cohen" });
    expect(page.careItems).toHaveLength(1);
  });

  it("no occasions for a household that is not a current member", async () => {
    const db = await testDb();
    const t = await team(db);
    const page = await getPersonPage({ db, sf: () => fakeSf({ member: false }).client, now: NOW }, t.clergy, CONTACT);
    expect(page.person!.occasions).toEqual([]);
  });

  it("caregivers never trigger a Salesforce read and see only their own care records", async () => {
    const db = await testDb();
    const t = await team(db);
    await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "birth", ownerUserId: t.carer.id, visibility: "caregivers" });
    const sf = fakeSf();
    const page = await getPersonPage({ db, sf: () => sf.client, now: NOW }, t.carer, CONTACT);
    expect(page.salesforce).toBe("hidden");
    expect(sf.queries).toEqual([]);
    await expect(getPersonPage({ db, sf: () => sf.client, now: NOW }, t.carer2, CONTACT)).rejects.toBeInstanceOf(NotFound);
  });

  it("unknown or malformed ids are NotFound", async () => {
    const db = await testDb();
    const t = await team(db);
    await expect(getPersonPage({ db, sf: () => fakeSf().client, now: NOW }, t.clergy, "nope")).rejects.toBeInstanceOf(NotFound);
    await expect(getPersonPage({ db, sf: () => fakeSf().client, now: NOW }, t.clergy, CONTACT2)).rejects.toBeInstanceOf(NotFound);
  });
});
