import { describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { getTodayCare, listCareBoard, parseCareBoardFilter } from "@/server/care/boards";
import { closeCareItem, createCareItem } from "@/server/care/care-items";
import { createFollowUp, setFollowUpDone } from "@/server/care/follow-ups";
import { getTextDrafts, setTextDraft } from "@/server/care/text-drafts";
import { InvalidInput } from "@/server/care/validate";
import { getUpcomingOccasions } from "@/server/lifecycle/occasions";
import { draftFor, renderDraft } from "@/server/lifecycle/sms";
import type { Occasion } from "@/server/lifecycle/types";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { ACCOUNT, CONTACT, CONTACT2, team, testDb } from "./support/db";

const occasion = (over: Partial<Occasion> = {}): Occasion => ({
  type: "yahrzeit",
  date: "2026-11-23",
  subjectId: "a0B000000000001AAA",
  personName: "Abe Cohen",
  personFirstName: "Abe",
  hebrewName: null,
  hebrewDeathDate: null,
  contactHebrewName: null,
  household: "Ruth and Sam Cohen",
  informalGreeting: "Ruth and Sam",
  accountId: ACCOUNT,
  contactId: CONTACT,
  contactName: "Ruth Cohen",
  contactFirstName: "Ruth",
  mobile: "314-555-0101",
  phone: null,
  years: 10,
  relationship: null,
  deathDate: null,
  ...over,
});

describe("text drafts", () => {
  it("each user keeps their own draft per type; blank returns to the default", async () => {
    const db = await testDb();
    const t = await team(db);
    await setTextDraft(db, t.clergy, { occasionType: "yahrzeit", body: "Thinking of you, {first_name}." });
    await setTextDraft(db, t.clergy, { occasionType: "birthday", body: "Mazel tov {name}!" });
    expect(await getTextDrafts(db, t.clergy)).toEqual({ yahrzeit: "Thinking of you, {first_name}.", birthday: "Mazel tov {name}!" });
    expect(await getTextDrafts(db, t.clergy2)).toEqual({});
    await setTextDraft(db, t.clergy, { occasionType: "yahrzeit", body: "Updated" });
    await setTextDraft(db, t.clergy, { occasionType: "birthday", body: "  " });
    expect(await getTextDrafts(db, t.clergy)).toEqual({ yahrzeit: "Updated" });
  });

  it("validates type and length; caregivers have no drafts", async () => {
    const db = await testDb();
    const t = await team(db);
    await expect(setTextDraft(db, t.clergy, { occasionType: "wedding", body: "x" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(setTextDraft(db, t.clergy, { occasionType: "birthday", body: "x".repeat(501) })).rejects.toBeInstanceOf(InvalidInput);
    await expect(setTextDraft(db, t.carer, { occasionType: "birthday", body: "x" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("fills placeholders, and a missing value leaves no stray comma", () => {
    expect(renderDraft("Hi {first_name}, remembering {name} {when}.", occasion(), "2026-11-23")).toBe("Hi Ruth, remembering Abe Cohen today.");
    expect(renderDraft("Hi {first_name}, remembering {name} {when}.", occasion({ contactFirstName: null, date: "2026-11-25" }), "2026-11-23")).toBe("Hi, remembering Abe Cohen this week.");
    expect(renderDraft("{first_name}, happy anniversary {household}!", occasion({ type: "anniversary", contactFirstName: null }), "2026-11-23")).toBe("happy anniversary Ruth and Sam!");
    expect(draftFor(occasion(), "2026-11-23", {})).toContain("May their memory be a blessing");
    expect(draftFor(occasion(), "2026-11-23", { yahrzeit: "Own {first_name}" })).toBe("Own Ruth");
  });
});

describe("Today and Care list data", () => {
  it("due follow-ups are the actor's or unassigned; attention lists the actor's items with nothing planned", async () => {
    const db = await testDb();
    const t = await team(db);
    const planned = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness" });
    const unplanned = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam", category: "bereavement" });
    await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Other's", category: "birth", ownerUserId: t.clergy2.id });
    const overdue = await createFollowUp(db, t.clergy, { careItemId: planned.id, title: "Call", dueDate: "2026-11-20" });
    await createFollowUp(db, t.clergy, { careItemId: planned.id, title: "Later", dueDate: "2026-12-20" });
    await createFollowUp(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", title: "Someone else's", dueDate: "2026-11-21", ownerUserId: t.clergy2.id });
    const done = await createFollowUp(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", title: "Done", dueDate: "2026-11-21" });
    await setFollowUpDone(db, t.clergy, done.id, true);

    const today = await getTodayCare(db, t.clergy, "2026-11-23");
    expect(today.due.map((f) => f.id)).toEqual([overdue.id]);
    expect(today.attention.map((i) => i.id)).toEqual([unplanned.id]);
    await expect(getTodayCare(db, t.clergy, "yesterday")).rejects.toBeInstanceOf(InvalidInput);
  });

  it("the care list filters by mine/all, category and status, with owner and next follow-up", async () => {
    const db = await testDb();
    const t = await team(db);
    const a = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness" });
    const b = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam", category: "bereavement", ownerUserId: t.clergy2.id });
    const c = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Closed", category: "illness" });
    await closeCareItem(db, t.clergy, c.id);
    await createFollowUp(db, t.clergy, { careItemId: a.id, title: "x", dueDate: "2026-12-01" });
    await createFollowUp(db, t.clergy, { careItemId: a.id, title: "y", dueDate: "2026-11-28" });

    const all = await listCareBoard(db, t.clergy, parseCareBoardFilter({}));
    expect(all.map((r) => [r.id, r.ownerName, r.nextFollowUp])).toEqual([
      [a.id, "clergy", "2026-11-28"],
      [b.id, "clergy2", null],
    ]);
    expect((await listCareBoard(db, t.clergy, parseCareBoardFilter({ scope: "mine" }))).map((r) => r.id)).toEqual([a.id]);
    expect((await listCareBoard(db, t.clergy, parseCareBoardFilter({ category: "bereavement" }))).map((r) => r.id)).toEqual([b.id]);
    expect((await listCareBoard(db, t.clergy, parseCareBoardFilter({ status: "closed" }))).map((r) => r.id)).toEqual([c.id]);
    expect(parseCareBoardFilter({ scope: "x", category: "finance", status: 1 })).toEqual({ scope: "all", category: null, status: "open" });
  });
});

describe("getUpcomingOccasions", () => {
  const household: SfRow = { Name: "Cohen", npo02__Formal_Greeting__c: "Ruth and Sam Cohen", cs_Member__c: true, npe01__One2OneContact__c: CONTACT, npe01__One2OneContact__r: { Name: "Ruth Cohen", FirstName: "Ruth", MobilePhone: "314-555-0101" } };
  const sf: SalesforceClient = {
    async query(soql) {
      if (soql.includes("FROM Contact"))
        return [
          { Id: CONTACT, Name: "Ruth Cohen", FirstName: "Ruth", Birthdate: "1986-11-23", AccountId: ACCOUNT, Account: household },
          { Id: CONTACT2, Name: "Sam Cohen", FirstName: "Sam", Birthdate: "1980-12-10", AccountId: ACCOUNT, Account: household },
        ];
      return [];
    },
  };

  it("groups the next 7 or 30 days by day, today included", async () => {
    const db = await testDb();
    const t = await team(db);
    const now = new Date("2026-11-23T16:00:00Z");
    const week = await getUpcomingOccasions({ db, sf: () => sf, now }, t.clergy, 7);
    expect(week.byDay.map((d) => [d.date, d.occasions.length])).toEqual([["2026-11-23", 1]]);
    const month = await getUpcomingOccasions({ db, sf: () => sf, now }, t.clergy, 30);
    expect(month.end).toBe("2026-12-22");
    expect(month.byDay.map((d) => d.date)).toEqual(["2026-11-23", "2026-12-10"]);
    await expect(getUpcomingOccasions({ db, sf: () => sf, now }, t.carer, 7)).rejects.toBeInstanceOf(AccessDenied);
  });
});
