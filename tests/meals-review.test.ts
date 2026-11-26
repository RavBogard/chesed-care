import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { canSeeMealFamilyLink } from "@/server/access/policy";
import { InvalidInput } from "@/server/care/validate";
import { auditLog, mealPageBlocks, mealPages, mealRateLimits, mealSignups } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { familyEnd, familyPause, familyResume, getFamilyView, thankHelper, updateFoodNeeds } from "@/server/meals/family";
import { deliveryIcs } from "@/server/meals/ics";
import { addCoOrganiser, endMealPage, getMealPageForOrganiser, listMealPages, pauseMealPage, removeCoOrganiser, resumeMealPage, updateMealPage } from "@/server/meals/pages";
import { cancelMySignup, changeMySignup, getMySignup, getPublicMealPage, mealSignupIcs, signUpForMeal } from "@/server/meals/public";
import { purgeMealData } from "@/server/meals/purge";
import { LIMITS } from "@/server/meals/rate-limit";
import { bookOnBehalf, listPastHelpers, removeSignup, withdrawDate } from "@/server/meals/slots";
import { reporters, team, testDb } from "./support/db";
import { ADDRESS, helper, INSTRUCTIONS, livePage, meta, NOW, type LivePage } from "./support/meals";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
let page: LivePage;

const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const audit = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);

async function signUp(slot: number, over: Record<string, unknown> = {}) {
  const result = await signUpForMeal(db, page.publicToken, page.slots[slot].id, helper(over), meta(), NOW);
  if (!result.ok) throw new Error(`sign-up refused: ${result.reason}`);
  return result;
}

beforeEach(async () => {
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
  page = await livePage(db, t.staff);
});

describe("the page's sign-up ceiling", () => {
  it("cannot be used to lock a family's page: only sign-ups that succeed count against it", async () => {
    await signUp(0);
    // Far more junk than the ceiling, from as many clients as an attacker likes: bad input, taken nights, dead dates.
    for (let i = 0; i < LIMITS.signupPerPage + 10; i++) {
      const junk = [helper({ email: "nope" }), helper(), helper({ extra: 1 })][i % 3];
      const result = await signUpForMeal(db, page.publicToken, i % 3 === 1 ? page.slots[0].id : page.slots[1].id, junk, meta(), NOW);
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toMatchObject({ reason: "rate_limited" });
    }
    const [bucket] = await db.select().from(mealRateLimits).where(eq(mealRateLimits.key, `signup:page:${page.id}`));
    expect(bucket.count).toBe(1);
    expect((await signUp(1)).details.dropOffAddress).toBe(ADDRESS);

    // Real sign-ups still meet the ceiling.
    await db.update(mealRateLimits).set({ count: LIMITS.signupPerPage - 1 }).where(eq(mealRateLimits.key, `signup:page:${page.id}`));
    expect((await signUp(2)).ok).toBe(true);
    const more = await livePage(db, t.staff);
    expect((await signUpForMeal(db, more.publicToken, more.slots[0].id, helper(), meta(), NOW)).ok).toBe(true);
    const [full] = await db.select().from(mealRateLimits).where(eq(mealRateLimits.key, `signup:page:${page.id}`));
    expect(full.count).toBe(LIMITS.signupPerPage);
  });

  it("the counters have an index on their window, for the pruning delete", async () => {
    const rows = await db.execute(sql`select indexname from pg_indexes where tablename = 'meal_rate_limits'`);
    expect(JSON.stringify(rows)).toContain("meal_rate_limits_window_idx");
  });
});

describe("signing up and cancelling leaves a trace", () => {
  it("every sign-up and every helper cancellation is an audit row, and the organiser sees who cancelled", async () => {
    const harvester = await signUp(0, { firstName: "Mal", lastName: "Lory", email: "mal@example.test" });
    expect(harvester.details.dropOffAddress).toBe(ADDRESS);
    const later = new Date(NOW.getTime() + 60_000);
    expect(await cancelMySignup(db, harvester.manageToken, meta(), later)).toEqual({ ok: true });
    await cancelMySignup(db, harvester.manageToken, meta(), later); // twice is one cancellation
    const removed = await signUp(1, { firstName: "Pat", email: "pat@example.test" });
    await removeSignup(db, t.staff, page.id, removed.signupId, {}, new Date(NOW.getTime() + 120_000));
    const standing = await signUp(2);

    const created = await audit("meal_signup.create");
    expect(created.map((r) => r.subjectId).sort()).toEqual([harvester.signupId, removed.signupId, standing.signupId].sort());
    expect(created.every((r) => r.actorUserId === null && r.subjectType === "meal_signup")).toBe(true);
    expect(await audit("meal_signup.cancel")).toMatchObject([{ actorUserId: null, subjectType: "meal_signup", subjectId: harvester.signupId, detail: { mealPageId: page.id, slotId: page.slots[0].id, by: "helper" } }]);
    expect(words(await db.select().from(auditLog))).not.toMatch(/Mal|Lory|@example|Maple/);

    const view = await getMealPageForOrganiser(db, t.staff, page.id, NOW);
    expect(view.cancelledSignups).toEqual([
      { id: removed.signupId, firstName: "Pat", lastName: "Levy", email: "pat@example.test", date: "2026-12-03", meal: "dinner", cancelledAt: new Date(NOW.getTime() + 120_000), cancelledBy: "organiser" },
      { id: harvester.signupId, firstName: "Mal", lastName: "Lory", email: "mal@example.test", date: "2026-12-01", meal: "dinner", cancelledAt: later, cancelledBy: "helper" },
    ]);
    expect(view.slots.map((s) => s.signup?.id ?? null)).toEqual([null, null, standing.signupId]);
    // The public and family views say nothing of it.
    expect(words([await getPublicMealPage(db, page.publicToken, NOW), await getFamilyView(db, page.familyToken, NOW)])).not.toMatch(/Mal|Pat|cancel/);
  });

  it("organiser actions on a page are recorded too: co-organisers, where the food goes, bookings and withdrawn dates", async () => {
    await addCoOrganiser(db, t.staff, page.id, t.lead.id, NOW);
    await addCoOrganiser(db, t.staff, page.id, t.lead.id, NOW); // already one: no second row
    await removeCoOrganiser(db, t.staff, page.id, t.lead.id, NOW);
    await removeCoOrganiser(db, t.staff, page.id, t.lead.id, NOW);
    expect(await audit("meal_page.add_organiser")).toMatchObject([{ actorUserId: t.staff.id, subjectId: page.id, detail: { by: "organiser", userId: t.lead.id } }]);
    expect(await audit("meal_page.remove_organiser")).toMatchObject([{ actorUserId: t.staff.id, subjectId: page.id, detail: { by: "organiser", userId: t.lead.id } }]);

    await updateMealPage(db, t.staff, page.id, { note: "A new note", title: "the Cohens", dropOffAddress: ADDRESS, dropOffWindow: "5 to 6 pm" }, NOW);
    expect(await audit("meal_page.update")).toHaveLength(0); // nothing about where the food goes changed
    await updateMealPage(db, t.staff, page.id, { dropOffAddress: "99 Elsewhere Road", dropOffIsHome: false, dropOffInstructions: "Ring the bell", note: "Another" }, NOW);
    await updateMealPage(db, t.staff, page.id, { dropOffWindow: "after 7" }, NOW);
    expect((await audit("meal_page.update")).map((r) => r.detail)).toEqual([
      { by: "organiser", fields: ["dropOffAddress", "dropOffIsHome", "dropOffInstructions"] },
      { by: "organiser", fields: ["dropOffWindow"] },
    ]);

    const booked = await bookOnBehalf(db, t.staff, page.id, page.slots[0].id, { firstName: "Miriam", kind: "cook" });
    expect(await audit("meal_signup.create")).toMatchObject([{ actorUserId: t.staff.id, subjectType: "meal_signup", subjectId: booked.signupId, detail: { mealPageId: page.id, slotId: page.slots[0].id, by: "organiser" } }]);
    await withdrawDate(db, t.staff, page.id, page.slots[1].id, NOW);
    expect(await audit("meal_page.withdraw_date")).toMatchObject([{ actorUserId: t.staff.id, subjectId: page.id, detail: { by: "organiser", slotId: page.slots[1].id } }]);
    expect(words(await db.select().from(auditLog))).not.toMatch(/Elsewhere|Ring the bell|Miriam|after 7|new note/);
  });
});

describe("after a page has ended", () => {
  it("the family link shows only who helped, so they can be thanked: no address, instructions or food needs", async () => {
    const mine = await signUp(0);
    await signUp(2, { firstName: "Eli", lastName: "Stein", email: "eli@example.test" });
    await endMealPage(db, t.staff, page.id, NOW);
    const view = (await getFamilyView(db, page.familyToken, day(3)))!;
    expect(Object.keys(view).sort()).toEqual(["helped", "status", "title", "today"]);
    expect(view).toMatchObject({ status: "ended", title: "the Cohen family", helped: [{ date: "2026-12-01", helper: { firstName: "Dana", lastName: "Levy", thanked: false } }, { date: "2026-12-05", helper: { firstName: "Eli" } }] });
    expect(words(view)).not.toMatch(/Maple|porch|Peanuts|adults|5 to 6|@|nut free|kosher/);
    expect(await updateFoodNeeds(db, page.familyToken, { allergies: "x" }, meta(), day(3))).toEqual({ ok: false, reason: "closed" });
    expect(await thankHelper(db, page.familyToken, mine.signupId, "Thank you", meta(), day(3))).toMatchObject({ ok: true, view: { status: "ended", helped: [{ helper: { thanked: true } }, { helper: { thanked: false } }] } });
    expect(await getMySignup(db, mine.manageToken, day(3))).toMatchObject({ state: "ended", thanks: { text: "Thank you" } });
  });

  it("at thirty days the purge empties the page and both links stop resolving; every helper keeps a name and an email", async () => {
    const plain = await signUp(0);
    const opted = await signUp(1, { firstName: "Eli", email: "eli@example.test", mayContactAgain: true });
    // Opted in, but removed and blocked by the organiser: kept, but never offered as a past helper.
    const pest = await signUp(2, { firstName: "Pat", email: "pest@example.test", mayContactAgain: true });
    await removeSignup(db, t.staff, page.id, pest.signupId, { blockEmail: true }, NOW);
    // Opted in and removed without a block: kept, never offered either.
    const removed = await signUp(2, { firstName: "Rem", email: "rem@example.test", mayContactAgain: true });
    await removeSignup(db, t.staff, page.id, removed.signupId, {}, NOW);
    // Opted in, cancelled by themselves, and their email was blocked afterwards through another sign-up of theirs.
    const again = await signUp(2, { firstName: "Bo", email: "bo@example.test", mayContactAgain: true });
    await cancelMySignup(db, again.manageToken, meta(), NOW);
    const second = await signUp(2, { firstName: "Bo", email: "bo@example.test", mayContactAgain: true });
    await removeSignup(db, t.staff, page.id, second.signupId, { blockEmail: true }, NOW);
    await thankHelper(db, page.familyToken, opted.signupId, "Thank you Eli", meta(), NOW);
    await endMealPage(db, t.staff, page.id, NOW);

    expect(await purgeMealData(db, day(29))).toEqual({ pages: 0, signups: 0 });
    expect(await getFamilyView(db, page.familyToken, day(29))).toMatchObject({ status: "ended" });
    expect(await purgeMealData(db, day(30))).toEqual({ pages: 1, signups: 6 });

    const [stored] = await db.select().from(mealPages).where(eq(mealPages.id, page.id));
    expect(stored).toMatchObject({
      title: "the Cohen family",
      status: "ended",
      kashrut: "kosher_style",
      publicToken: null,
      publicTokenHash: null,
      familyToken: null,
      familyTokenHash: null,
      dropOffAddress: null,
      dropOffInstructions: null,
      dropOffWindow: null,
      allergies: null,
      foodFor: null,
      note: null,
      deliveryPlaces: null,
      giftCards: null,
      giftCardEmail: null,
    });
    const rows = Object.fromEntries((await db.select().from(mealSignups)).map((r) => [r.id, r]));
    expect(rows[opted.signupId]).toMatchObject({ firstName: "Eli", lastName: "Levy", email: "eli@example.test", bringing: null, note: null, thanksText: null });
    expect(rows[plain.signupId]).toMatchObject({ firstName: "Dana", lastName: "Levy", bringing: null, note: null, thanksText: null });
    expect(rows[plain.signupId].email).not.toBeNull();
    expect([pest, removed, again, second].map((k) => rows[k.signupId].email)).toEqual(["pest@example.test", "rem@example.test", "bo@example.test", "bo@example.test"]);
    for (const k of [pest, removed, again, second]) expect(rows[k.signupId]).toMatchObject({ bringing: null, note: null, thanksText: null });
    expect(words([stored, Object.values(rows)])).not.toMatch(/Maple|porch|Peanuts|Lasagne|See you|Pi Pizzeria|Schnucks|cohens@/);

    // Neither link resolves, and neither does anything else that hangs off them.
    expect(await getPublicMealPage(db, page.publicToken, day(30))).toBeNull();
    expect(await getFamilyView(db, page.familyToken, day(30))).toBeNull();
    expect(await thankHelper(db, page.familyToken, opted.signupId, "Late thanks", meta(), day(30))).toEqual({ ok: false, reason: "not_found" });
    for (const token of [null, "", undefined]) {
      expect(await getPublicMealPage(db, token, day(30))).toBeNull();
      expect(await getFamilyView(db, token, day(30))).toBeNull();
    }
    // A helper's own link stops resolving with the other links (the sign-up is purged).
    expect(await getMySignup(db, plain.manageToken, day(30))).toBeNull();
    // The organiser still sees that the page existed, without its links; the opted-in helper is still on the list.
    expect(await getMealPageForOrganiser(db, t.staff, page.id, day(30))).toMatchObject({ status: "ended", publicToken: null, familyToken: null, dropOffAddress: null, blockedEmails: [] });
    expect(await listPastHelpers(db, t.staff, day(30))).toEqual([{ firstName: "Eli", lastName: "Levy", email: "eli@example.test", lastHelped: "2026-12-03" }]);
    expect(await purgeMealData(db, day(31))).toEqual({ pages: 0, signups: 0 });
  });
});

describe("a blocked helper who still holds a sign-up", () => {
  it("has the ask-me-again tick turned off before the block goes, and is never offered as a past helper", async () => {
    const kept = await signUp(0, { firstName: "Eli", email: "eli@example.test", mayContactAgain: true });
    const blocked = await signUp(1, { firstName: "Pat", email: "pat@example.test", mayContactAgain: true });
    // A block on the page while Pat's sign-up still stands (not cancelled).
    await db.insert(mealPageBlocks).values({ pageId: page.id, email: "pat@example.test", blockedBy: t.staff.id });
    await endMealPage(db, t.staff, page.id, NOW);
    await purgeMealData(db, day(31));
    expect(await db.select().from(mealPageBlocks)).toEqual([]);
    const rows = Object.fromEntries((await db.select().from(mealSignups)).map((r) => [r.id, r]));
    expect(rows[blocked.signupId]).toMatchObject({ email: "pat@example.test", cancelledAt: null, mayContactAgain: false });
    expect(rows[kept.signupId]).toMatchObject({ email: "eli@example.test", mayContactAgain: true });
    expect((await listPastHelpers(db, t.staff, day(31))).map((h) => h.email)).toEqual(["eli@example.test"]);
  });
});

describe("pausing, and who holds the family's link", () => {
  it("the family resumes only a pause the family made", async () => {
    expect(await pauseMealPage(db, t.staff, page.id, NOW)).toMatchObject({ status: "paused", pausedBy: "organiser" });
    expect(await getFamilyView(db, page.familyToken, NOW)).toMatchObject({ status: "paused", canResume: false });
    expect(await familyResume(db, page.familyToken, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    expect(await getPublicMealPage(db, page.publicToken, NOW)).toEqual({ status: "paused", title: "the Cohen family" });
    expect(await audit("meal_page.resume")).toHaveLength(0);
    expect(await resumeMealPage(db, t.staff, page.id, NOW)).toMatchObject({ status: "live", pausedBy: null });

    expect(await familyPause(db, page.familyToken, meta(), NOW)).toMatchObject({ ok: true, view: { status: "paused", canResume: true } });
    expect(await getMealPageForOrganiser(db, t.staff, page.id, NOW)).toMatchObject({ status: "paused", pausedBy: "family" });
    expect(await familyResume(db, page.familyToken, meta(), NOW)).toMatchObject({ ok: true, view: { status: "live", canResume: false } });
    // An organiser may lift the family's pause; the family may still end a page the organiser paused.
    await familyPause(db, page.familyToken, meta(), NOW);
    expect((await resumeMealPage(db, t.staff, page.id, NOW)).status).toBe("live");
    await pauseMealPage(db, t.staff, page.id, NOW);
    expect(await familyEnd(db, page.familyToken, meta(), NOW)).toMatchObject({ ok: true, view: { status: "ended" } });
    expect((await db.select().from(mealPages).where(eq(mealPages.id, page.id)))[0].pausedBy).toBeNull();
  });

  it("the family link goes only to the page's organisers and to clergy who can see it, and never into a list", async () => {
    const co = await addCoOrganiser(db, t.staff, page.id, t.lead.id, NOW);
    expect(co.familyToken).toBe(page.familyToken);
    for (const actor of [t.staff, t.lead, t.clergy, t.owner]) expect((await getMealPageForOrganiser(db, actor, page.id, NOW)).familyToken, actor.email).toBe(page.familyToken);
    // A lead sees every page, but is given the family link only for pages they organise.
    await removeCoOrganiser(db, t.staff, page.id, t.lead.id, NOW);
    const forLead = await getMealPageForOrganiser(db, t.lead, page.id, NOW);
    expect(forLead).toMatchObject({ familyToken: null, publicToken: page.publicToken, dropOffAddress: ADDRESS });
    expect(JSON.stringify(forLead)).not.toContain(page.familyToken);
    for (const actor of [t.staff, t.lead, t.clergy, t.owner]) expect(words(await listMealPages(db, actor, NOW))).not.toMatch(/oken/);

    const row = { organiserUserId: t.staff.id, coOrganiser: false, careItem: null };
    expect([t.staff, t.lead, t.clergy, t.owner, t.carer, t.senior].map((a) => canSeeMealFamilyLink(a, row))).toEqual([true, false, true, true, false, false]);
    expect(canSeeMealFamilyLink(t.lead, { ...row, coOrganiser: true })).toBe(true);
    // Clergy shut out of a restricted care item are shut out of the page, and so of its link.
    expect(canSeeMealFamilyLink(t.clergy, { ...row, careItem: { ownerUserId: t.clergy2.id, restricted: true, named: false } })).toBe(false);
  });
});

describe("small hardening", () => {
  it("a calendar file escapes every kind of line break, and a bare carriage return is refused on the way in", async () => {
    const ics = deliveryIcs({ uid: "u", date: "2026-12-03", nextDay: "2026-12-04", summary: "a\rBEGIN:VALARM", address: "1 Road\r\nEND:VEVENT\rX-EVIL:1\nATTENDEE:x", window: "5\r6", stamp: NOW });
    const lines = ics.split("\r\n");
    expect(lines.filter((l) => /^(BEGIN|END|ATTENDEE|X-EVIL)/.test(l))).toEqual(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "END:VEVENT", "END:VCALENDAR"]);
    expect(ics).not.toMatch(/\r(?!\n)/);
    expect(ics).toContain("LOCATION:1 Road\\nEND:VEVENT\\nX-EVIL:1\\nATTENDEE:x");
    expect(ics).toContain("SUMMARY:a\\nBEGIN:VALARM");

    for (const patch of [{ dropOffAddress: "1 Road\rEND:VEVENT" }, { dropOffInstructions: "a\rb" }, { note: "a\r" }, { title: "a\r\nb" }, { dropOffWindow: "5\n6" }]) await expect(updateMealPage(db, t.staff, page.id, patch, NOW), JSON.stringify(patch)).rejects.toBeInstanceOf(InvalidInput);
    expect(await updateFoodNeeds(db, page.familyToken, { dropOffInstructions: "a\rb" }, meta(), NOW)).toEqual({ ok: false, reason: "invalid", fields: ["dropOffInstructions"] });
    expect(await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ note: "a\rb" }), meta(), NOW)).toEqual({ ok: false, reason: "invalid", fields: ["note"] });
    // An honest line break is kept, as \n.
    const ok = await updateMealPage(db, t.staff, page.id, { dropOffAddress: "12 Maple Lane\r\nSt. Louis", dropOffInstructions: `${INSTRUCTIONS}\nThank you` }, NOW);
    expect(ok).toMatchObject({ dropOffAddress: "12 Maple Lane\nSt. Louis", dropOffInstructions: `${INSTRUCTIONS}\nThank you` });
    const mine = await signUp(0);
    expect(await mealSignupIcs(db, mine.manageToken, NOW)).toContain("LOCATION:12 Maple Lane\\nSt. Louis\r\n");
  });

  it("an empty change returns the sign-up as it stands", async () => {
    const mine = await signUp(0);
    const before = await getMySignup(db, mine.manageToken, NOW);
    expect(await changeMySignup(db, mine.manageToken, {}, meta(), NOW)).toEqual({ ok: true, signup: before });
    expect((await db.select().from(mealSignups))[0]).toMatchObject({ bringing: "Lasagne", note: "See you at six" });
  });
});
