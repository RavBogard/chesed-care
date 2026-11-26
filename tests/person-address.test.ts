import { beforeEach, describe, expect, it } from "vitest";
import { formatAddress, makeAddress, mapsUrl, placeOf, type Address } from "@/lib/address";
import { AccessDenied } from "@/server/access/policy";
import { getBrief } from "@/server/care/brief";
import { createOutsidePerson, getOutsidePerson, outsideAddress } from "@/server/care/outside-people";
import { addressSuggestion } from "@/server/care/person-address";
import { getPersonPage } from "@/server/care/person-page";
import { InvalidInput } from "@/server/care/validate";
import type { Db } from "@/server/db/types";
import { findPeopleQuery, findPeopleCapped } from "@/server/lifecycle/find-people";
import { addressOf } from "@/server/lifecycle/fields";
import { householdNamesQuery, searchHouseholdNames } from "@/server/lifecycle/household-names";
import { personQueries } from "@/server/lifecycle/person";
import { TOOLS } from "@/server/mcp/tools";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { words } from "./support/words";

const NOW = new Date("2026-12-01T18:00:00Z");
const addr = (over: Partial<Address> = {}): Address => ({ street: "12 Maple Ave", city: "Clayton", state: "MO", postalCode: "63105", source: "contact", ...over });

describe("formatAddress and mapsUrl", () => {
  it("gives two lines and a one-line form", () => {
    expect(formatAddress(addr())).toEqual({ lines: ["12 Maple Ave", "Clayton, MO 63105"], oneLine: "12 Maple Ave, Clayton, MO 63105" });
  });

  it("keeps an apartment line, joins multi-line streets with a comma and collapses whitespace", () => {
    const a = makeAddress({ street: "  12 Maple   Ave \r\n Apt 4B\n\n", city: " Clayton ", state: "MO", postalCode: "63105" }, "contact")!;
    expect(a.street).toBe("12 Maple Ave, Apt 4B");
    expect(formatAddress(a).oneLine).toBe("12 Maple Ave, Apt 4B, Clayton, MO 63105");
  });

  it("copes with a missing state or postal code", () => {
    expect(formatAddress(addr({ state: null })).lines).toEqual(["12 Maple Ave", "Clayton 63105"]);
    expect(formatAddress(addr({ state: null, postalCode: null, city: null })).lines).toEqual(["12 Maple Ave"]);
  });

  it("builds the universal Google Maps link from the one-line address, encoded", () => {
    expect(mapsUrl(addr())).toBe("https://www.google.com/maps/search/?api=1&query=12%20Maple%20Ave%2C%20Clayton%2C%20MO%2063105");
    const odd = mapsUrl(addr({ street: "5 O'Brien & Sons #2 <b>" }))!;
    const query = odd.split("query=")[1];
    expect(query).not.toMatch(/[<>& #]/);
    expect(decodeURIComponent(query)).toBe("5 O'Brien & Sons #2 <b>, Clayton, MO 63105");
  });

  it("refuses a link with no street or with control characters", () => {
    expect(mapsUrl(addr({ street: null }))).toBeNull();
    expect(mapsUrl(addr({ street: "12 Maple\u0000 Ave" }))).toBeNull();
    expect(mapsUrl(addr({ city: "Clay\u0007ton" }))).toBeNull();
    expect(mapsUrl(addr({ postalCode: "63105\u009f" }))).toBeNull();
    expect(makeAddress({ street: " ", city: null }, "contact")).toBeNull();
  });

  it("placeOf is city and state only", () => {
    expect(placeOf(addr())).toBe("Clayton, MO");
    expect(placeOf(addr({ city: null, state: null }))).toBeNull();
    expect(placeOf(null)).toBeNull();
  });
});

describe("addressOf", () => {
  const contact: SfRow = { MailingStreet: "1 Own St", MailingCity: "Clayton", MailingState: "MO", MailingPostalCode: "63105" };
  const account: SfRow = { BillingStreet: "9 Home Rd", BillingCity: "Ladue", BillingState: "MO", BillingPostalCode: "63124" };

  it("prefers the contact's mailing address", () => {
    expect(addressOf(contact, account)).toMatchObject({ street: "1 Own St", source: "contact" });
  });
  it("falls back to the household's billing address when the contact has none", () => {
    expect(addressOf({ MailingStreet: null }, account)).toMatchObject({ street: "9 Home Rd", city: "Ladue", source: "household" });
    expect(addressOf(null, account)).toMatchObject({ source: "household" });
  });
  it("prefers a household street over a contact with only a city", () => {
    expect(addressOf({ MailingCity: "Clayton" }, account)).toMatchObject({ street: "9 Home Rd", source: "household" });
  });
  it("is null when Salesforce has none", () => {
    expect(addressOf({ MailingStreet: null }, { BillingStreet: "" })).toBeNull();
  });
});

describe("queries stay SELECT-only and non-financial", () => {
  it("the person and Find queries read only the standard address fields", () => {
    const q = personQueries(CONTACT, ACCOUNT, "2026-12-01");
    for (const s of [q.person, q.members!, q.observances!]) expect(() => assertReadOnlySoql(s)).not.toThrow();
    expect(q.person).toContain("MailingStreet, MailingCity, MailingState, MailingPostalCode");
    expect(q.person).toContain("Account.BillingStreet, Account.BillingCity, Account.BillingState, Account.BillingPostalCode");
    const find = findPeopleQuery(["Cohen"]);
    expect(() => assertReadOnlySoql(find)).not.toThrow();
    expect(find).toContain("MailingCity, MailingState, Account.BillingCity, Account.BillingState");
    expect(find).not.toMatch(/Street|PostalCode/);
    for (const s of [q.person, find]) expect(s).not.toMatch(/Opportunit|Amount|Gift|Donation/i);
  });

  it("the name-only household search selects no address", () => {
    expect(householdNamesQuery(["Cohen"])).not.toMatch(/Mailing|Billing|Street|City|State|Postal/);
  });
});

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
beforeEach(async () => {
  db = await testDb();
  t = await team(db);
});

const noMailing = { MailingStreet: null, MailingCity: null, MailingState: null, MailingPostalCode: null };
const ruth = (over: SfRow = {}): SfRow => ({
  Id: CONTACT,
  Name: "Ruth Cohen",
  FirstName: "Ruth",
  MobilePhone: "(314) 555-0101",
  npsp__Deceased__c: false,
  AccountId: ACCOUNT,
  MailingStreet: "12 Maple Ave\nApt 4B",
  MailingCity: "Clayton",
  MailingState: "MO",
  MailingPostalCode: "63105",
  Account: { Name: "Cohen Household", cs_Member__c: true, BillingStreet: "9 Home Rd", BillingCity: "Ladue", BillingState: "MO", BillingPostalCode: "63124" },
  ...over,
});
function sfWith(row: SfRow) {
  const queries: string[] = [];
  const client: SalesforceClient = {
    async query(soql) {
      queries.push(assertReadOnlySoql(soql));
      if (soql.includes("WHERE Id = '003") || soql.includes("WHERE AccountId") || soql.includes("LIKE")) return [row];
      return [];
    },
  };
  return { sf: () => client, queries };
}

describe("the address on the person page, the brief and the connector", () => {
  it("is on the page for clergy level, from the contact first and then the household", async () => {
    const own = await getPersonPage({ db, sf: sfWith(ruth()).sf, now: NOW }, t.clergy, CONTACT);
    expect(own.person?.address).toMatchObject({ street: "12 Maple Ave, Apt 4B", source: "contact" });
    // A fresh database: the first read above is cached for the day.
    const db2 = await testDb();
    const fallback = await getPersonPage({ db: db2, sf: sfWith(ruth(noMailing)).sf, now: NOW }, (await team(db2)).clergy, CONTACT);
    expect(fallback.person?.address).toMatchObject({ street: "9 Home Rd", source: "household" });
  });

  it("is absent when Salesforce has none, and never reaches a role that does not see phones", async () => {
    const none = await getPersonPage({ db, sf: sfWith(ruth({ ...noMailing, Account: { Name: "Cohen", cs_Member__c: true } })).sf, now: NOW }, t.owner, CONTACT);
    expect(none.person?.address).toBeNull();
    const seen = await getPersonPage({ db, sf: sfWith(ruth()).sf, now: NOW }, t.carer, CONTACT).catch(() => null);
    expect(JSON.stringify(seen)).not.toContain("Maple");
  });

  it("the brief carries lines and the Maps link; only for those who may brief", async () => {
    const brief = await getBrief({ db, sf: sfWith(ruth()).sf, now: NOW }, t.clergy, { contactId: CONTACT });
    expect(brief.address).toEqual({
      lines: ["12 Maple Ave, Apt 4B", "Clayton, MO 63105"],
      oneLine: "12 Maple Ave, Apt 4B, Clayton, MO 63105",
      mapsUrl: expect.stringContaining("https://www.google.com/maps/search/?api=1&query="),
    });
    const r = await reporters(db);
    for (const a of [t.carer, r.staff, r.lead, r.senior]) await expect(getBrief({ db, sf: sfWith(ruth()).sf, now: NOW }, a, { contactId: CONTACT })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("the connector shows it on the person page and in the brief, and the find tool does not", async () => {
    const sf = sfWith(ruth());
    const run = (name: string, actor: typeof t.clergy, input: object) => TOOLS.find((x) => x.name === name)!.run({ db, sf: sf.sf, now: NOW, actor }, input as never);
    const got = (await run("care_get_person", t.clergy, { contactId: CONTACT })) as { address: { oneLine: string; mapsUrl: string } };
    expect(got.address.oneLine).toBe("12 Maple Ave, Apt 4B, Clayton, MO 63105");
    expect(got.address.mapsUrl).toContain("google.com/maps");
    const brief = (await run("care_brief_person", t.clergy, { contactId: CONTACT })) as { brief: { address: unknown } };
    expect(brief.brief.address).not.toBeNull();
    const found = await run("care_find_person", t.clergy, { query: "Cohen" });
    expect(words(found)).not.toMatch(/Maple|Clayton|Ladue/);
    await expect(run("care_get_person", t.carer, { contactId: CONTACT })).rejects.toThrow();
  });
});

describe("Find and the name-only household search", () => {
  it("Find rows carry city and state only", async () => {
    const { people } = await findPeopleCapped({ sf: sfWith(ruth()).sf }, t.clergy, "Cohen");
    expect(people[0].place).toBe("Clayton, MO");
    expect(words(people)).not.toMatch(/Maple|63105|Street/);
  });

  it("the name-only search returns no address, whatever the rows hold", async () => {
    const r = await reporters(db);
    const rows = await searchHouseholdNames({ sf: sfWith(ruth()).sf }, r.staff, "Cohen");
    expect(Object.keys(rows[0]).sort()).toEqual(["accountId", "contactId", "household", "name"]);
    expect(words(rows)).not.toMatch(/Maple|Clayton|63105/);
  });
});

describe("outside people", () => {
  it("keep an optional address, validated like other text, shown the same way", async () => {
    const p = await createOutsidePerson(db, t.clergy, { name: "Denver Parent", addressStreet: " 5 Elm St ", addressCity: "Denver", addressState: "CO", addressPostalCode: "80202" });
    const back = await getOutsidePerson(db, t.clergy, p.id);
    expect(outsideAddress(back)).toEqual({ street: "5 Elm St", city: "Denver", state: "CO", postalCode: "80202", source: "app" });
    const bare = await createOutsidePerson(db, t.clergy, { name: "No Address" });
    expect(outsideAddress(bare)).toBeNull();
    await expect(createOutsidePerson(db, t.clergy, { name: "X", addressStreet: "x".repeat(201) })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createOutsidePerson(db, t.clergy, { name: "X", addressState: 5 })).rejects.toBeInstanceOf(InvalidInput);
    // Visibility is the existing rule: not for a caregiver.
    await expect(getOutsidePerson(db, t.carer, p.id)).rejects.toBeInstanceOf(AccessDenied);
    const brief = await getBrief({ db, sf: sfWith(ruth()).sf, now: NOW }, t.clergy, { outsidePersonId: p.id });
    expect(brief.address?.lines).toEqual(["5 Elm St", "Denver, CO 80202"]);
    const viaTool = (await TOOLS.find((x) => x.name === "care_get_person")!.run({ db, sf: sfWith(ruth()).sf, now: NOW, actor: t.clergy }, { outsidePersonId: p.id } as never)) as { address: { oneLine: string } };
    expect(viaTool.address.oneLine).toBe("5 Elm St, Denver, CO 80202");
  });
});

describe("Use their address", () => {
  it("is offered only to those who may see the address", async () => {
    const r = await reporters(db);
    const deps = { db, sf: sfWith(ruth()).sf, now: NOW };
    expect(await addressSuggestion(deps, t.clergy, { sfContactId: CONTACT })).toBe("12 Maple Ave, Apt 4B, Clayton, MO 63105");
    for (const a of [t.carer, r.staff, r.lead, r.senior]) expect(await addressSuggestion(deps, a, { sfContactId: CONTACT })).toBeNull();
    const p = await createOutsidePerson(db, t.clergy, { name: "Denver Parent", addressStreet: "5 Elm St", addressCity: "Denver" });
    expect(await addressSuggestion(deps, t.clergy, { outsidePersonId: p.id })).toBe("5 Elm St, Denver");
    expect(await addressSuggestion(deps, r.staff, { outsidePersonId: p.id })).toBeNull();
    expect(await addressSuggestion(deps, t.clergy, {})).toBeNull();
  });
});
