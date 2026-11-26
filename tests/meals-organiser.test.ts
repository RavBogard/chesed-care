import { eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, canSeeMealPage, mealPageVisibleWhere, type Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { DatabaseError } from "@/server/db/errors";
import { auditLog, careItemAccess, careItems, mealPageOrganisers, mealPages } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { householdNamesQuery, resolveHouseholdName, searchHouseholdNames } from "@/server/lifecycle/household-names";
import { calendarNotes } from "@/server/meals/calendar-notes";
import { coverageOf, type SlotRow } from "@/server/meals/core";
import { mealsLineForPerson } from "@/server/meals/person-line";
import { addCoOrganiser, createMealPage, endMealPage, getMealPageForOrganiser, goLive, listMealPages, markFamilyAgreed, pauseMealPage, removeCoOrganiser, resumeMealPage, updateMealPage } from "@/server/meals/pages";
import { getPublicMealPage, signUpForMeal } from "@/server/meals/public";
import { addDates, bookOnBehalf, listPastHelpers, removeSignup, suggestDates, withdrawDate } from "@/server/meals/slots";
import { TOOLS } from "@/server/mcp/tools";
import { callTool } from "@/server/mcp/transport";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { ACCOUNT, addActor, CONTACT, reporters, team, testDb } from "./support/db";
import { helper, livePage, meta, NOW, pageInput, TODAY } from "./support/meals";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>> & { clergy3: Actor };

beforeEach(async () => {
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)), clergy3: await addActor(db, "clergy3@example.test", "clergy") };
});

const ids = (pages: { id: string }[]) => pages.map((p) => p.id).sort();

describe("who may run meal pages", () => {
  it("caregivers and senior staff have no access at all", async () => {
    const page = await createMealPage(db, t.clergy, pageInput(), NOW);
    for (const actor of [t.carer, t.senior]) {
      await expect(createMealPage(db, actor, pageInput(), NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(listMealPages(db, actor, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(getMealPageForOrganiser(db, actor, page.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(listPastHelpers(db, actor, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(mealsLineForPerson(db, actor, { sfContactId: CONTACT }, NOW)).rejects.toBeInstanceOf(AccessDenied);
    }
    // Being named a co-organiser is not a way in either.
    await expect(addCoOrganiser(db, t.clergy, page.id, t.carer.id, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await db.insert(mealPageOrganisers).values({ pageId: page.id, userId: t.senior.id });
    await expect(getMealPageForOrganiser(db, t.senior, page.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("staff see and manage only pages they organise or co-organise; owner, clergy and lead see all", async () => {
    const mine = await createMealPage(db, t.staff, pageInput({ title: "the Adler family" }), NOW);
    const leads = await createMealPage(db, t.lead, pageInput({ title: "the Baum family" }), NOW);
    const clergys = await createMealPage(db, t.clergy, pageInput({ title: "the Cohen family" }), NOW);
    const all = ids([mine, leads, clergys]);

    expect(ids(await listMealPages(db, t.staff, NOW))).toEqual([mine.id]);
    for (const actor of [t.owner, t.clergy, t.clergy2, t.lead]) expect(ids(await listMealPages(db, actor, NOW))).toEqual(all);
    await expect(getMealPageForOrganiser(db, t.staff, leads.id, NOW)).rejects.toBeInstanceOf(NotFound);
    await expect(updateMealPage(db, t.staff, clergys.id, { note: "x" }, NOW)).rejects.toBeInstanceOf(NotFound);
    await expect(endMealPage(db, t.staff, clergys.id, NOW)).rejects.toBeInstanceOf(NotFound);

    const shared = await addCoOrganiser(db, t.lead, leads.id, t.staff.id, NOW);
    expect(shared.organisers.map((o) => [o.name, o.lead])).toEqual([
      ["lead", true],
      ["staff", false],
    ]);
    const list = await listMealPages(db, t.staff, NOW);
    expect(ids(list)).toEqual(ids([mine, leads]));
    expect(list.every((p) => p.mine)).toBe(true);
    expect((await listMealPages(db, t.clergy2, NOW)).every((p) => !p.mine)).toBe(true);
    // Staff who take themselves off lose the page.
    expect(await removeCoOrganiser(db, t.staff, leads.id, t.staff.id, NOW)).toBeNull();
    expect(ids(await listMealPages(db, t.staff, NOW))).toEqual([mine.id]);
  });
});

describe("a page linked to a restricted care item", () => {
  const SECRET = "Chemotherapy starts Monday";
  async function setup() {
    const restricted = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET, restricted: true, accessUserIds: [t.clergy2.id] });
    const open = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "birth", summary: "A new baby" });
    return { restricted, open };
  }

  it("is created only by someone with full access to the item; for anyone else the item is not found, restricted or not", async () => {
    const { restricted, open } = await setup();
    // Not named: the owner role, another clergy member. Never able to read a care item: lead and staff.
    for (const actor of [t.owner, t.clergy3, t.lead, t.staff]) await expect(createMealPage(db, actor, pageInput({ careItemId: restricted.id }), NOW)).rejects.toBeInstanceOf(NotFound);
    for (const actor of [t.lead, t.staff]) await expect(createMealPage(db, actor, pageInput({ careItemId: open.id }), NOW)).rejects.toBeInstanceOf(NotFound);
    expect(await db.select().from(mealPages)).toHaveLength(0);

    const byOwner = await createMealPage(db, t.clergy, pageInput({ careItemId: restricted.id }), NOW);
    const byNamed = await createMealPage(db, t.clergy2, pageInput({ careItemId: restricted.id }), NOW);
    const onOpen = await createMealPage(db, t.clergy3, pageInput({ careItemId: open.id }), NOW);
    // The household comes from the care item; nothing else does.
    for (const page of [byOwner, byNamed, onOpen]) expect(page).toMatchObject({ sfContactId: CONTACT, sfAccountId: ACCOUNT });
    expect(byOwner.careItemId).toBe(restricted.id);
  });

  it("is listed and readable only for its organisers and those with full access; the SQL rule and the predicate agree", async () => {
    const { restricted, open } = await setup();
    const hidden = await createMealPage(db, t.clergy, pageInput({ careItemId: restricted.id, title: "the Cohen family" }), NOW);
    const onOpen = await createMealPage(db, t.clergy, pageInput({ careItemId: open.id }), NOW);
    const plain = await createMealPage(db, t.staff, pageInput({ title: "the Adler family" }), NOW);
    await addCoOrganiser(db, t.clergy, hidden.id, t.lead.id, NOW);

    const expected: [Actor, string[]][] = [
      [t.clergy, [hidden.id, onOpen.id, plain.id]], // owner of the item, and organiser
      [t.clergy2, [hidden.id, onOpen.id, plain.id]], // named on the item
      [t.clergy3, [onOpen.id, plain.id]],
      [t.owner, [onOpen.id, plain.id]], // no role overrides a restriction
      [t.lead, [hidden.id, onOpen.id, plain.id]], // co-organiser
      [t.staff, [plain.id]],
      [t.carer, []],
      [t.senior, []],
    ];
    const pages = await db.select().from(mealPages);
    const items = await db.select().from(careItems);
    const named = await db.select().from(careItemAccess);
    const co = await db.select().from(mealPageOrganisers);
    for (const [actor, visible] of expected) {
      const bySql = await db.select({ id: mealPages.id }).from(mealPages).where(mealPageVisibleWhere(actor));
      expect(ids(bySql), actor.email).toEqual([...visible].sort());
      const byPredicate = pages.filter((p) => {
        const item = items.find((i) => i.id === p.careItemId);
        return canSeeMealPage(actor, {
          organiserUserId: p.organiserUserId,
          coOrganiser: co.some((c) => c.pageId === p.id && c.userId === actor.id),
          careItem: item ? { ownerUserId: item.ownerUserId, restricted: item.restricted, named: named.some((n) => n.careItemId === item.id && n.userId === actor.id) } : null,
        });
      });
      expect(ids(byPredicate), actor.email).toEqual([...visible].sort());
    }
    for (const actor of [t.clergy3, t.owner, t.staff]) await expect(getMealPageForOrganiser(db, actor, hidden.id, NOW)).rejects.toBeInstanceOf(NotFound);

    // The link is shown only to those who fully read the item, and nothing of the item is on the page for anyone.
    expect((await getMealPageForOrganiser(db, t.clergy2, hidden.id, NOW)).careItemId).toBe(restricted.id);
    const forLead = await getMealPageForOrganiser(db, t.lead, hidden.id, NOW);
    expect(forLead.careItemId).toBeNull();
    expect((await getMealPageForOrganiser(db, t.lead, onOpen.id, NOW)).careItemId).toBeNull();
    for (const actor of [t.clergy, t.clergy2, t.lead]) {
      const text = JSON.stringify([await getMealPageForOrganiser(db, actor, hidden.id, NOW), await listMealPages(db, actor, NOW)]);
      for (const leak of [SECRET, "illness", "restricted", "summary", "category"]) expect(text, leak).not.toContain(leak);
    }
  });

  it("the meals line shows status, covered through and open dates, to clergy who can see the page", async () => {
    const { restricted } = await setup();
    const hidden = await livePage(db, t.clergy, { careItemId: restricted.id });
    const taken = await signUpForMeal(db, hidden.publicToken, hidden.slots[0].id, helper(), meta(), NOW);
    expect(taken.ok).toBe(true);
    const line = [{ pageId: hidden.id, title: "the Cohen family", status: "live", coveredThrough: "2026-12-01", openDates: 2 }];
    expect(await mealsLineForPerson(db, t.clergy, { sfContactId: CONTACT }, NOW)).toEqual(line);
    expect(await mealsLineForPerson(db, t.clergy2, { sfAccountId: ACCOUNT }, NOW)).toEqual(line);
    for (const actor of [t.clergy3, t.owner]) expect(await mealsLineForPerson(db, actor, { sfContactId: CONTACT, sfAccountId: ACCOUNT }, NOW)).toEqual([]);
    for (const actor of [t.lead, t.staff, t.carer, t.senior]) await expect(mealsLineForPerson(db, actor, { sfContactId: CONTACT }, NOW)).rejects.toBeInstanceOf(AccessDenied);

    // An unrestricted page about the same person is seen by all clergy; an ended one drops off the line.
    const plain = await livePage(db, t.lead, { sfContactId: CONTACT });
    expect((await mealsLineForPerson(db, t.clergy3, { sfContactId: CONTACT }, NOW)).map((l) => l.pageId)).toEqual([plain.id]);
    await endMealPage(db, t.lead, plain.id, NOW);
    expect(await mealsLineForPerson(db, t.clergy3, { sfContactId: CONTACT }, NOW)).toEqual([]);
  });
});

describe("the life of a page", () => {
  it("cannot go live until the family has agreed, in the code and in the database", async () => {
    const draft = await createMealPage(db, t.lead, pageInput(), NOW);
    expect(draft).toMatchObject({ status: "draft", familyAgreedAt: null, organiserUserId: t.lead.id });
    expect(draft.publicToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(draft.familyToken).not.toBe(draft.publicToken);
    await expect(goLive(db, t.lead, draft.id, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(db.update(mealPages).set({ status: "live" }).where(eq(mealPages.id, draft.id))).rejects.toBeInstanceOf(DatabaseError);
    await expect(pauseMealPage(db, t.lead, draft.id, NOW)).rejects.toBeInstanceOf(InvalidInput);

    expect(await markFamilyAgreed(db, t.lead, draft.id, NOW)).toMatchObject({ familyAgreedAt: NOW, familyAgreedBy: t.lead.id });
    expect((await goLive(db, t.lead, draft.id, NOW)).status).toBe("live");
    expect((await pauseMealPage(db, t.clergy, draft.id, NOW)).status).toBe("paused");
    await expect(goLive(db, t.lead, draft.id, NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect((await resumeMealPage(db, t.lead, draft.id, NOW)).status).toBe("live");
    expect(await endMealPage(db, t.lead, draft.id, NOW)).toMatchObject({ status: "ended", endedAt: NOW });
    await expect(resumeMealPage(db, t.lead, draft.id, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateMealPage(db, t.lead, draft.id, { note: "again" }, NOW)).rejects.toBeInstanceOf(InvalidInput);

    const audit = await db.select().from(auditLog).where(like(auditLog.action, "meal_page.%")).orderBy(auditLog.at);
    expect(audit.map((a) => a.action).sort()).toEqual(["meal_page.create", "meal_page.end", "meal_page.go_live", "meal_page.pause", "meal_page.resume"]);
    expect(audit.find((a) => a.action === "meal_page.pause")).toMatchObject({ actorUserId: t.clergy.id, subjectType: "meal_page", subjectId: draft.id, detail: { by: "organiser" } });
  });

  it("edits are strict: unknown keys, long text and control characters are refused; status and links are not editable", async () => {
    const page = await createMealPage(db, t.staff, pageInput(), NOW);
    const edited = await updateMealPage(db, t.staff, page.id, { note: "", dietary: ["Vegan", "vegan", "Low FODMAP"], dropOffIsHome: false, giftCardEmail: "Gifts@Example.test" }, NOW);
    expect(edited).toMatchObject({ note: null, dietary: ["vegan", "low fodmap"], dropOffIsHome: false, giftCardEmail: "gifts@example.test" });
    for (const bad of [{ status: "live" }, { publicToken: "x" }, { familyAgreedAt: NOW }, { organiserUserId: t.lead.id }, { note: "x".repeat(501) }, { title: "" }, { title: "a\u0000b" }, { kashrut: "halal" }, { giftCardEmail: "nope" }])
      await expect(updateMealPage(db, t.staff, page.id, bad, NOW), JSON.stringify(Object.keys(bad))).rejects.toBeInstanceOf(InvalidInput);
    await expect(createMealPage(db, t.staff, pageInput({ dates: [{ date: "2026-11-30" }] }), NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(createMealPage(db, t.staff, pageInput({ sfContactId: "not-an-id" }), NOW)).rejects.toBeInstanceOf(InvalidInput);
    // Outside people are clergy's; a staff member cannot attach one.
    await expect(createMealPage(db, t.staff, pageInput({ outsidePersonId: "00000000-0000-4000-8000-000000000000" }), NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("suggests every other day, adds dates, and keeps a withdrawn date's helper in sight as needing a call", async () => {
    expect(suggestDates("2026-12-01", 2)).toEqual(["2026-12-01", "2026-12-03", "2026-12-05", "2026-12-07", "2026-12-09", "2026-12-11", "2026-12-13"]);
    expect(suggestDates("2026-12-30", 1)).toEqual(["2026-12-30", "2027-01-01", "2027-01-03", "2027-01-05"]);
    expect(suggestDates("2026-12-01", 99)).toHaveLength(28);

    const page = await livePage(db, t.lead);
    const more = await addDates(db, t.lead, page.id, [{ date: "2026-12-07" }, { date: "2026-12-07", meal: "lunch" }, { date: "2026-12-03" }], NOW);
    expect(more.slots.map((s) => `${s.date} ${s.meal}`)).toEqual(["2026-12-01 dinner", "2026-12-03 dinner", "2026-12-05 dinner", "2026-12-07 dinner", "2026-12-07 lunch"]);
    await expect(addDates(db, t.lead, page.id, [{ date: "2026-11-01" }], NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(addDates(db, t.lead, page.id, [{ date: "2026-02-30" }], NOW)).rejects.toBeInstanceOf(InvalidInput);

    const third = page.slots[1];
    const signed = await signUpForMeal(db, page.publicToken, third.id, helper(), meta(), NOW);
    expect(signed.ok).toBe(true);
    const withdrawn = await withdrawDate(db, t.lead, page.id, third.id, NOW);
    expect(withdrawn.slots.find((s) => s.id === third.id)).toMatchObject({ status: "withdrawn", needsCall: true, signup: { firstName: "Dana", lastName: "Levy", email: "dana.levy@example.test" } });
    expect((await listMealPages(db, t.lead, NOW))[0]).toMatchObject({ needsCall: 1, coveredThrough: null, openDates: 4, nextOpenDate: "2026-12-01" });
    const pub = await getPublicMealPage(db, page.publicToken, NOW);
    expect(pub?.status === "live" && pub.dates.map((d) => d.date)).toEqual(["2026-12-01", "2026-12-05", "2026-12-07", "2026-12-07"]);
    // Offered again, it is the same date and the same helper.
    const back = await addDates(db, t.lead, page.id, [{ date: "2026-12-03" }], NOW);
    expect(back.slots.find((s) => s.id === third.id)).toMatchObject({ status: "open", needsCall: false, signup: { firstName: "Dana" } });
    await expect(withdrawDate(db, t.lead, page.id, (await livePage(db, t.clergy)).slots[0].id, NOW)).rejects.toBeInstanceOf(NotFound);
  });

  it("books on someone's behalf, removes a sign-up and can block its email from the page", async () => {
    const page = await livePage(db, t.staff);
    const [first, second] = page.slots;
    const booked = await bookOnBehalf(db, t.staff, page.id, first.id, { firstName: "Miriam", kind: "cook", bringing: "Soup" });
    expect(booked.manageToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await expect(bookOnBehalf(db, t.staff, page.id, first.id, { firstName: "Noa", kind: "cook" })).rejects.toBeInstanceOf(InvalidInput);
    const signed = await signUpForMeal(db, page.publicToken, second.id, helper({ email: "pest@example.test" }), meta(), NOW);
    if (!signed.ok) throw new Error(signed.reason);
    let view = await getMealPageForOrganiser(db, t.staff, page.id, NOW);
    expect(view.slots[0].signup).toMatchObject({ firstName: "Miriam", lastName: null, email: null, onBehalf: true });
    expect(view.slots[1].signup).toMatchObject({ email: "pest@example.test", onBehalf: false });

    await expect(removeSignup(db, t.lead, (await livePage(db, t.lead)).id, signed.signupId, {}, NOW)).rejects.toBeInstanceOf(NotFound); // another page's sign-up
    view = await removeSignup(db, t.staff, page.id, signed.signupId, { blockEmail: true }, NOW);
    expect(view.slots[1].signup).toBeNull();
    expect(view.blockedEmails).toEqual(["pest@example.test"]);
    expect(await signUpForMeal(db, page.publicToken, second.id, helper({ email: " PEST@example.test " }), meta(), NOW)).toEqual({ ok: false, reason: "refused" });
    expect((await signUpForMeal(db, page.publicToken, second.id, helper({ email: "friend@example.test" }), meta(), NOW)).ok).toBe(true);

    const audit = await db.select().from(auditLog);
    expect(audit.find((a) => a.action === "meal_signup.remove")).toMatchObject({ subjectType: "meal_signup", subjectId: signed.signupId, detail: { mealPageId: page.id, by: "organiser", blocked: true } });
    expect(audit.find((a) => a.action === "meal_page.block_email")).toMatchObject({ subjectId: page.id, detail: { by: "organiser" } });
    expect(JSON.stringify(audit)).not.toContain("pest@");
  });

  it("lists past helpers who asked to be called on again, from pages the actor can see", async () => {
    const page = await livePage(db, t.staff);
    await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ email: "yes@example.test", mayContactAgain: true }), meta(), NOW);
    await signUpForMeal(db, page.publicToken, page.slots[1].id, helper({ firstName: "Eli", email: "no@example.test" }), meta(), NOW);
    await signUpForMeal(db, page.publicToken, page.slots[2].id, helper({ firstName: "Future", email: "later@example.test", mayContactAgain: true }), meta(), NOW);
    const later = new Date("2026-12-04T18:00:00Z");
    expect(await listPastHelpers(db, t.staff, later)).toEqual([{ firstName: "Dana", lastName: "Levy", email: "yes@example.test", lastHelped: "2026-12-01" }]);
    expect(await listPastHelpers(db, t.lead, later)).toHaveLength(1);
    const other = await addActor(db, "staff2@example.test", "staff");
    expect(await listPastHelpers(db, other, later)).toEqual([]);
  });
});

describe("the name-only household search", () => {
  const row: SfRow = {
    Id: CONTACT,
    Name: "Ruth Cohen",
    AccountId: ACCOUNT,
    // More than was asked for: a real query never returns these, and the result must not carry them if one did.
    MobilePhone: "314-555-0101",
    Phone: "314-555-0102",
    Birthdate: "1986-11-23",
    MailingStreet: "12 Maple Lane",
    Hebrew_Name__c: "רות",
    Account: { Name: "Cohen Household", npo02__Formal_Greeting__c: "Ruth and Sam Cohen", BillingStreet: "12 Maple Lane", Phone: "314-555-0103" },
  };
  const queries: string[] = [];
  const sf = (): SalesforceClient => ({
    async query(soql) {
      queries.push(assertReadOnlySoql(soql));
      return [row];
    },
  });

  it("returns a name, a household and two Ids for staff and leads: no phones, addresses or dates", async () => {
    for (const actor of [t.staff, t.lead, t.clergy, t.owner]) {
      expect(await searchHouseholdNames({ sf }, actor, "cohen")).toEqual([{ contactId: CONTACT, name: "Ruth Cohen", accountId: ACCOUNT, household: "Ruth and Sam Cohen" }]);
      expect(await resolveHouseholdName({ sf }, actor, CONTACT)).toEqual({ contactId: CONTACT, name: "Ruth Cohen", accountId: ACCOUNT, household: "Ruth and Sam Cohen" });
    }
    for (const soql of [...queries, householdNamesQuery(["o'brien"])]) {
      expect(soql).not.toMatch(/phone|mobile|street|mailing|billing|address|email|birth|date|hebrew|yahrzeit/i);
      expect(soql).toContain("Account.cs_Member__c = true");
    }
    for (const actor of [t.carer, t.senior]) {
      await expect(searchHouseholdNames({ sf }, actor, "cohen")).rejects.toBeInstanceOf(AccessDenied);
      await expect(resolveHouseholdName({ sf }, actor, CONTACT)).rejects.toBeInstanceOf(AccessDenied);
    }
    await expect(searchHouseholdNames({ sf }, t.staff, "c")).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchHouseholdNames({ sf }, t.staff, "x' OR Name != '")).rejects.toBeInstanceOf(InvalidInput);
    await searchHouseholdNames({ sf }, t.staff, "o'brien");
    expect(queries.at(-1)).toContain("\\'");
  });

  it("gives no sign of who is in care: the answer is the same with and without care records and meal pages", async () => {
    const before = await searchHouseholdNames({ sf }, t.staff, "ruth cohen");
    await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "In hospital", restricted: true });
    await livePage(db, t.clergy, { sfContactId: CONTACT });
    const reads = queries.length;
    expect(await searchHouseholdNames({ sf }, t.staff, "ruth cohen")).toEqual(before);
    // One Salesforce read and nothing else: it never looks at this app's records.
    expect(queries.length).toBe(reads + 1);
    expect(Object.keys(before[0]).sort()).toEqual(["accountId", "contactId", "household", "name"]);
  });
});

describe("coverage and the calendar", () => {
  it("covered through is the last date before the first open one", () => {
    const row = (date: string, taken: boolean, status: "open" | "withdrawn" = "open") => ({ slot: { date, status }, signup: taken ? {} : null }) as unknown as SlotRow;
    expect(coverageOf([row("2026-11-29", false), row("2026-12-01", true), row("2026-12-03", true), row("2026-12-05", false), row("2026-12-07", true)], TODAY)).toEqual({ coveredThrough: "2026-12-03", openDates: 1, nextOpenDate: "2026-12-05" });
    expect(coverageOf([row("2026-12-01", false), row("2026-12-03", true)], TODAY)).toEqual({ coveredThrough: null, openDates: 1, nextOpenDate: "2026-12-01" });
    expect(coverageOf([row("2026-12-01", true), row("2026-12-02", false, "withdrawn"), row("2026-12-03", true)], TODAY)).toEqual({ coveredThrough: "2026-12-03", openDates: 0, nextOpenDate: null });
    expect(coverageOf([], TODAY)).toEqual({ coveredThrough: null, openDates: 0, nextOpenDate: null });
  });

  it("marks Shabbat and holidays and gives candle-lighting for St. Louis on Fridays and holiday eves", () => {
    const notes = Object.fromEntries(calendarNotes(["2026-12-01", "2026-12-04", "2026-12-05", "2026-09-11", "2026-09-12", "2027-04-21", "2027-04-22", "not-a-date"]).map((n) => [n.date, n]));
    expect(Object.keys(notes)).toHaveLength(7);
    expect(notes["2026-12-01"]).toEqual({ date: "2026-12-01", hebrewDate: "כ״א כסלו", shabbat: false, holiday: null, candleLighting: null });
    expect(notes["2026-12-04"]).toMatchObject({ shabbat: false, holiday: "Chanukah" });
    expect(notes["2026-12-04"].candleLighting).toMatch(/^4:2\d PM$/); // sunset in St. Louis that day is 4:39
    expect(notes["2026-12-05"]).toMatchObject({ shabbat: true, holiday: "Chanukah", candleLighting: null });
    expect(notes["2026-09-11"]).toMatchObject({ holiday: "Erev Rosh Hashana" });
    expect(notes["2026-09-11"].candleLighting).toMatch(/^6:5\d PM$/);
    expect(notes["2026-09-12"]).toMatchObject({ shabbat: true, holiday: "Rosh Hashana", hebrewDate: "א׳ תשרי" });
    expect(notes["2027-04-21"]).toMatchObject({ holiday: "Erev Pesach" });
    expect(notes["2027-04-21"].candleLighting).toMatch(/^7:2\d PM$/);
    expect(notes["2027-04-22"]).toMatchObject({ holiday: "Pesach", shabbat: false });
    // One day of yom tov, as a Reform congregation keeps: the diaspora's second days are not marked.
    const one = Object.fromEntries(calendarNotes(["2026-10-02", "2026-10-03", "2026-10-04", "2027-06-11", "2027-06-12", "2026-09-13"]).map((n) => [n.date, n]));
    expect(one["2026-10-03"].holiday).toMatch(/Shmini Atzeret|Simchat Torah/);
    expect(one["2026-10-04"]).toMatchObject({ holiday: null, candleLighting: null });
    expect(one["2027-06-11"]).toMatchObject({ holiday: "Shavuot" });
    expect(one["2027-06-12"]).toMatchObject({ holiday: null, shabbat: true });
    expect(one["2026-09-13"]).toMatchObject({ holiday: "Rosh Hashana" }); // two days everywhere
    expect(one["2026-10-02"].candleLighting).toMatch(/^6:2\d PM$/); // a Friday, and the eve of the holiday
    expect(calendarNotes([])).toEqual([]);
    expect(calendarNotes(["2020-01-01", "2026-01-01"])).toEqual([]);
  });
});

describe("connector", () => {
  const sf = (): SalesforceClient => ({ query: async () => [{ Id: CONTACT, Name: "Ruth Cohen", AccountId: ACCOUNT, Account: { Name: "Cohen Household" } }] });
  const tool = (name: string) => TOOLS.find((x) => x.name === name)!;
  const call = (name: string, actor: Actor, args: unknown) => callTool(tool(name), args, { db, sf, now: NOW, actor });

  it("meals_start_page makes a draft that only the app can take live; meals_coverage reads what the person can see", async () => {
    const started = await call("meals_start_page", t.lead, { title: "the Cohen family", contactId: CONTACT, dates: ["2026-12-02", "2026-12-04"], kashrut: "vegetarian_or_dairy", dietary: ["nut free"] });
    expect(started.isError).toBe(false);
    const out = started.structuredContent as { mealPageId: string; finishInApp: string };
    expect(out).toMatchObject({ started: true, status: "draft", dates: 2, finishInApp: expect.stringMatching(/\/meals\/[0-9a-f-]{36}$/) });
    expect(words(out)).not.toMatch(/token/i);
    const [stored] = await db.select().from(mealPages);
    expect(stored).toMatchObject({ status: "draft", familyAgreedAt: null, sfContactId: CONTACT, sfAccountId: ACCOUNT, organiserUserId: t.lead.id, kashrut: "vegetarian_or_dairy" });
    expect(JSON.stringify(out)).not.toContain(stored.publicToken!);
    // No argument marks the family as agreed or sets a status.
    for (const extra of [{ familyAgreed: true }, { status: "live" }, { careItemId: "x" }]) expect((await call("meals_start_page", t.lead, { title: "x", dates: ["2026-12-02"], ...extra })).isError).toBe(true);

    const coverage = await call("meals_coverage", t.staff, {});
    expect(coverage.structuredContent).toEqual({ today: TODAY, pages: [] });
    expect((await call("meals_coverage", t.clergy, {})).structuredContent).toEqual({ today: TODAY, pages: [{ mealPageId: out.mealPageId, title: "the Cohen family", status: "draft", coveredThrough: null, openDates: 2, nextOpenDate: "2026-12-02" }] });
    for (const actor of [t.carer, t.senior]) {
      expect(await call("meals_coverage", actor, {})).toMatchObject({ isError: true, content: [{ text: "You do not have access to do that." }] });
      expect((await call("meals_start_page", actor, { title: "x", dates: ["2026-12-02"] })).isError).toBe(true);
    }
    expect(await db.select().from(mealPages)).toHaveLength(1);
  });
});
