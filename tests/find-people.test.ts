import { describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { InvalidInput } from "@/server/care/validate";
import { canLoadMore, escapeLike, FIND_LIMIT, FIND_MAX_OFFSET, findPeople, findPeopleQuery, searchWords } from "@/server/lifecycle/find-people";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { addActor, testDb } from "./support/db";

const ACC = "001000000000001AAA";
const C1 = "003000000000001AAA";

function fakeSf(rows: SfRow[]) {
  const queries: string[] = [];
  const client: SalesforceClient = {
    async query(soql) {
      queries.push(assertReadOnlySoql(soql));
      return rows;
    },
  };
  return { client, queries };
}

const member = (over: Partial<SfRow> = {}): SfRow => ({
  Id: C1,
  Name: "Ruth Cohen",
  FirstName: "Ruth",
  Hebrew_Name__c: "רות",
  AccountId: ACC,
  Account: { Name: "Cohen Household", npo02__Formal_Greeting__c: "Ruth and Sam Cohen", cs_Member__c: true },
  ...over,
});

describe("findPeople", () => {
  it("searches current-member households only, never the deceased, capped", async () => {
    const q = findPeopleQuery(["Cohen"]);
    expect(q).toContain("Account.cs_Member__c = true");
    expect(q).toContain("npsp__Deceased__c = false");
    expect(q).toContain(`LIMIT ${FIND_LIMIT}`);
    expect(() => assertReadOnlySoql(q)).not.toThrow();
  });

  it("pages past 25 by a safe, bounded offset", () => {
    const q = findPeopleQuery(["Cohen"], 25);
    expect(q).toContain(`LIMIT ${FIND_LIMIT} OFFSET 25`);
    expect(() => assertReadOnlySoql(q)).not.toThrow();
    expect(findPeopleQuery(["Cohen"])).not.toContain("OFFSET");
    for (const bad of [-25, 7, 1000, 1.5, Number.NaN]) expect(() => findPeopleQuery(["Cohen"], bad)).toThrow();
  });

  it("offers Load more only while a next page is allowed", () => {
    expect(canLoadMore(true, FIND_LIMIT, 0)).toBe(true);
    expect(canLoadMore(true, FIND_LIMIT, FIND_MAX_OFFSET - FIND_LIMIT)).toBe(true);
    expect(canLoadMore(true, FIND_LIMIT, FIND_MAX_OFFSET)).toBe(false);
    expect(canLoadMore(false, FIND_LIMIT, 0)).toBe(false);
    expect(canLoadMore(true, FIND_LIMIT - 1, 0)).toBe(false);
  });

  it("every word must match the person's or the household's name", () => {
    const q = findPeopleQuery(["ruth", "cohen"]);
    expect(q).toContain("(Name LIKE '%ruth%' OR Account.Name LIKE '%ruth%') AND (Name LIKE '%cohen%' OR Account.Name LIKE '%cohen%')");
  });

  it("escapes quotes, backslashes and LIKE wildcards", () => {
    expect(escapeLike("O'Brien")).toBe("O\\'Brien");
    expect(escapeLike("a%b_c\\")).toBe("a\\%b\\_c\\\\");
    const q = findPeopleQuery(searchWords("O'Brien"));
    expect(q).toContain("'%O\\'Brien%'");
    expect(() => assertReadOnlySoql(q)).not.toThrow();
  });

  it("refuses input that is not a plain name", () => {
    for (const bad of [undefined, 42, "", "a", "x".repeat(61), "Cohen%", "Co_hen", "a' OR Name != '", "Cohen; DELETE", "a b c d e", "--", "\\"]) {
      expect(() => searchWords(bad), String(bad)).toThrow(InvalidInput);
    }
    expect(searchWords("  Ruth   Cohen ")).toEqual(["Ruth", "Cohen"]);
    expect(searchWords("כהן")).toEqual(["כהן"]);
    expect(searchWords("O’Neil")).toEqual(["O'Neil"]);
  });

  it("maps matches and drops non-members or malformed rows", async () => {
    const db = await testDb();
    const actor = await addActor(db, "rabbi@crc.test", "owner");
    const sf = fakeSf([member(), member({ Id: "bad", Name: "Bad" }), member({ Id: "003000000000002AAA", Account: { cs_Member__c: false } })]);
    const out = await findPeople({ sf: () => sf.client }, actor, "Cohen");
    expect(out).toEqual([{ contactId: C1, name: "Ruth Cohen", firstName: "Ruth", hebrewName: "רות", accountId: ACC, household: "Ruth and Sam Cohen", place: null }]);
    expect(sf.queries).toHaveLength(1);
  });

  it("is refused for caregivers and never queries", async () => {
    const db = await testDb();
    const carer = await addActor(db, "carer@crc.test", "caregiver");
    const sf = fakeSf([]);
    await expect(findPeople({ sf: () => sf.client }, carer, "Cohen")).rejects.toBeInstanceOf(AccessDenied);
    expect(sf.queries).toEqual([]);
  });
});
