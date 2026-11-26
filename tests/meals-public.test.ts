import { eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { isUuid } from "@/server/care/validate";
import { auditLog, mealPageBlocks, mealPages, mealRateLimits, mealSignups } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { familyEnd, familyPause, familyResume, getFamilyView, thankHelper, updateFoodNeeds } from "@/server/meals/family";
import { createMealPage, endMealPage, getMealPageForOrganiser, pauseMealPage } from "@/server/meals/pages";
import { cancelMySignup, changeMySignup, getMySignup, getPublicMealPage, mealSignupIcs, signUpForMeal } from "@/server/meals/public";
import { purgeMealData } from "@/server/meals/purge";
import { LIMITS, withinLimit } from "@/server/meals/rate-limit";
import { removeSignup, withdrawDate } from "@/server/meals/slots";
import { tokenHash } from "@/server/meals/tokens";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { ADDRESS, helper, INSTRUCTIONS, livePage, meta, NOW, pageInput, type LivePage } from "./support/meals";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
let page: LivePage;

const SECRET = "Chemotherapy starts Monday";
const LIVE_KEYS = ["allergies", "congregation", "dates", "deliveryPlaces", "dietary", "dropOffWindow", "foodFor", "giftCardEmail", "giftCards", "kashrut", "note", "status", "title"];
/** Everything the public page must never carry, whoever is looking. */
const NEVER = [ADDRESS, "Maple", INSTRUCTIONS, "porch", "Levy", "dana.levy", "See you at six", "lead@", SECRET, "illness", "restricted", CONTACT, ACCOUNT];

async function signUp(slot: number, over: Record<string, unknown> = {}, on: LivePage = page) {
  const result = await signUpForMeal(db, on.publicToken, on.slots[slot].id, helper(over), meta(), NOW);
  if (!result.ok) throw new Error(`sign-up refused: ${result.reason}`);
  return result;
}

beforeEach(async () => {
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
  // The hardest case: a page linked to a restricted care item.
  const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET, restricted: true });
  page = await livePage(db, t.clergy, { careItemId: item.id });
});

describe("the public page", () => {
  it("shows exactly its allow-list: never a last name, an email, the address, the instructions or anything of the care record", async () => {
    await signUp(0);
    const pub = await getPublicMealPage(db, page.publicToken, NOW);
    if (pub?.status !== "live") throw new Error("not live");
    expect(Object.keys(pub).sort()).toEqual(LIVE_KEYS);
    expect(pub).toMatchObject({
      title: "the Cohen family",
      note: "Thank you for helping",
      congregation: "Central Reform Congregation",
      foodFor: "2 adults, 3 children",
      kashrut: "kosher_style",
      dietary: ["nut free"],
      allergies: "Peanuts",
      dropOffWindow: "5 to 6 pm",
      deliveryPlaces: "Pi Pizzeria",
      giftCards: "Schnucks",
      giftCardEmail: "cohens@example.test",
    });
    expect(pub.dates).toEqual([
      { slotId: page.slots[0].id, date: "2026-12-01", meal: "dinner", past: false, taken: { firstName: "Dana", kind: "cook", bringing: "Lasagne", foodType: "dairy" } },
      { slotId: page.slots[1].id, date: "2026-12-03", meal: "dinner", past: false, taken: null },
      { slotId: page.slots[2].id, date: "2026-12-05", meal: "dinner", past: false, taken: null },
    ]);
    const text = JSON.stringify(pub);
    for (const leak of [...NEVER, page.familyToken, page.publicToken, page.id, t.clergy.id]) expect(text, leak).not.toContain(leak);
    // The only email on the page is the one the family chose for gift cards.
    expect(text.match(/[^"\s]+@[^"\s]+/g)).toEqual(["cohens@example.test"]);
  });

  it("a draft, paused or ended page gives its status and title and nothing else, until the purge; after it the link is not found", async () => {
    await signUp(0);
    const draft = await createMealPage(db, t.lead, pageInput({ title: "the Baum family" }), NOW);
    expect(await getPublicMealPage(db, draft.publicToken, NOW)).toEqual({ status: "draft", title: "the Baum family" });
    await pauseMealPage(db, t.clergy, page.id, NOW);
    expect(await getPublicMealPage(db, page.publicToken, NOW)).toEqual({ status: "paused", title: "the Cohen family" });
    expect(await signUpForMeal(db, page.publicToken, page.slots[1].id, helper(), meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    await endMealPage(db, t.clergy, page.id, NOW);
    expect(await getPublicMealPage(db, page.publicToken, NOW)).toEqual({ status: "ended", title: "the Cohen family" });
    expect(await signUpForMeal(db, draft.publicToken, draft.slots[0].id, helper(), meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    // Twenty-nine days after it ended the link still says so; from the thirtieth it is simply not found.
    const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
    await purgeMealData(db, day(29));
    expect(await getPublicMealPage(db, page.publicToken, day(29))).toEqual({ status: "ended", title: "the Cohen family" });
    await purgeMealData(db, day(30));
    expect(await getPublicMealPage(db, page.publicToken, day(30))).toBeNull();
    expect(await signUpForMeal(db, page.publicToken, page.slots[1].id, helper(), meta(), day(30))).toEqual({ ok: false, reason: "not_found" });
    expect(await getPublicMealPage(db, draft.publicToken, day(30))).toEqual({ status: "draft", title: "the Baum family" });
  });

  it("a wrong token is not found, whatever it is, and each kind of token opens only its own door", async () => {
    const signed = await signUp(0);
    const wrong = ["", "x", "a".repeat(32), page.publicToken.slice(0, -1), `${page.publicToken}x`, page.publicToken.toUpperCase(), "a".repeat(5000), "' or 1=1 --", null, undefined, 7, {}, [page.publicToken], page.id];
    for (const token of wrong) {
      expect(await getPublicMealPage(db, token, NOW)).toBeNull();
      expect(await getFamilyView(db, token, NOW)).toBeNull();
      expect(await getMySignup(db, token, NOW)).toBeNull();
      expect(await mealSignupIcs(db, token, NOW)).toBeNull();
      // The same answer whether or not the slot exists: nothing about the page can be probed without its token.
      for (const slot of [page.slots[1].id, "nope"]) expect(await signUpForMeal(db, token, slot, helper(), meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
      expect(await changeMySignup(db, token, { bringing: "x" }, meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
      expect(await cancelMySignup(db, token, meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
      expect(await updateFoodNeeds(db, token, { allergies: "x" }, meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
      expect(await familyEnd(db, token, meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
    }
    // An ended page and a page that never existed look the same to a sign-up without the real token.
    await endMealPage(db, t.clergy, page.id, NOW);
    expect(await signUpForMeal(db, "a".repeat(32), page.slots[1].id, helper(), meta(), NOW)).toEqual({ ok: false, reason: "not_found" });

    const tokens = { public: page.publicToken, family: page.familyToken, manage: signed.manageToken };
    expect(await getPublicMealPage(db, tokens.family, NOW)).toBeNull();
    expect(await getPublicMealPage(db, tokens.manage, NOW)).toBeNull();
    expect(await getFamilyView(db, tokens.public, NOW)).toBeNull();
    expect(await getFamilyView(db, tokens.manage, NOW)).toBeNull();
    expect(await getMySignup(db, tokens.public, NOW)).toBeNull();
    expect(await getMySignup(db, tokens.family, NOW)).toBeNull();
  });

  it("stores links as the brief says: public and family as given, the manage token only as a hash", async () => {
    const signed = await signUp(0);
    expect(signed.manageToken).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 random bytes
    const [stored] = await db.select().from(mealPages).where(eq(mealPages.id, page.id));
    expect(stored).toMatchObject({ publicToken: page.publicToken, familyToken: page.familyToken, publicTokenHash: tokenHash(page.publicToken) });
    const rows = await db.select().from(mealSignups);
    expect(JSON.stringify(rows)).not.toContain(signed.manageToken);
    expect(rows[0]).toMatchObject({ manageTokenHash: tokenHash(signed.manageToken), email: "dana.levy@example.test" });
    expect(new Set([page.publicToken, page.familyToken, signed.manageToken]).size).toBe(3);
  });
});

describe("signing up", () => {
  it("gives the address, window and instructions only in answer to a sign-up", async () => {
    const signed = await signUp(1);
    expect(isUuid(signed.signupId)).toBe(true);
    expect(signed.details).toEqual({
      title: "the Cohen family",
      date: "2026-12-03",
      meal: "dinner",
      dropOffAddress: ADDRESS,
      dropOffIsHome: true,
      dropOffWindow: "5 to 6 pm",
      dropOffInstructions: INSTRUCTIONS,
      foodFor: "2 adults, 3 children",
      kashrut: "kosher_style",
      dietary: ["nut free"],
      allergies: "Peanuts",
    });
    expect(JSON.stringify(signed)).not.toContain(SECRET);
  });

  it("of two people who take the same night at once, exactly one wins and the other is told it was just taken", async () => {
    const slot = page.slots[1].id;
    const results = await Promise.all([
      signUpForMeal(db, page.publicToken, slot, helper({ firstName: "Ana", email: "ana@example.test" }), meta(), NOW),
      signUpForMeal(db, page.publicToken, slot, helper({ firstName: "Ben", email: "ben@example.test" }), meta(), NOW),
      signUpForMeal(db, page.publicToken, slot, helper({ firstName: "Cal", email: "cal@example.test" }), meta(), NOW),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "taken" },
      { ok: false, reason: "taken" },
    ]);
    expect(await db.select().from(mealSignups).where(isNull(mealSignups.cancelledAt))).toHaveLength(1);
    // The database itself refuses a second active sign-up, whatever the code does.
    await expect(db.insert(mealSignups).values({ slotId: slot, kind: "cook", manageTokenHash: "h" })).rejects.toMatchObject({ name: "DatabaseError", code: "23505" });
    expect(await signUpForMeal(db, page.publicToken, slot, helper(), meta(), NOW)).toEqual({ ok: false, reason: "taken" });
  });

  it("refuses a past date, a withdrawn date and a date from another page", async () => {
    const tomorrow = new Date("2026-12-02T18:00:00Z");
    expect(await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(), tomorrow)).toEqual({ ok: false, reason: "unavailable" });
    await withdrawDate(db, t.clergy, page.id, page.slots[1].id, NOW);
    expect(await signUpForMeal(db, page.publicToken, page.slots[1].id, helper(), meta(), NOW)).toEqual({ ok: false, reason: "unavailable" });
    const other = await livePage(db, t.lead);
    expect(await signUpForMeal(db, page.publicToken, other.slots[0].id, helper(), meta(), NOW)).toEqual({ ok: false, reason: "unavailable" });
    for (const slot of ["nope", null, { id: page.slots[2].id }]) expect(await signUpForMeal(db, page.publicToken, slot, helper(), meta(), NOW)).toEqual({ ok: false, reason: "unavailable" });
    expect(await db.select().from(mealSignups)).toHaveLength(0);
    // Late on the day itself is still that day in St. Louis.
    expect((await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(), new Date("2026-12-02T05:30:00Z"))).ok).toBe(true);
  });

  it("refuses a blocked email, however it is typed", async () => {
    const first = await signUp(0, { email: "pest@example.test" });
    await removeSignup(db, t.clergy, page.id, first.signupId, { blockEmail: true }, NOW);
    for (const email of ["pest@example.test", "PEST@Example.TEST", "  pest@example.test  "]) expect(await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ email }), meta(), NOW)).toEqual({ ok: false, reason: "refused" });
    // Blocked from this page only.
    const other = await livePage(db, t.lead);
    expect((await signUpForMeal(db, other.publicToken, other.slots[0].id, helper({ email: "pest@example.test" }), meta(), NOW)).ok).toBe(true);
  });

  it("is strict about its input: caps, unknown keys, the honeypot and a form filled too fast", async () => {
    const slot = page.slots[0].id;
    const invalid = (over: Record<string, unknown>) => signUpForMeal(db, page.publicToken, slot, helper(over), meta(), NOW);
    expect(await invalid({ bringing: "x".repeat(201) })).toEqual({ ok: false, reason: "invalid", fields: ["bringing"] });
    expect(await invalid({ note: "x".repeat(301), email: "not-an-email" })).toEqual({ ok: false, reason: "invalid", fields: ["email", "note"] });
    expect(await invalid({ firstName: " ", lastName: "x".repeat(61) })).toMatchObject({ reason: "invalid", fields: ["firstName", "lastName"] });
    expect(await invalid({ kind: "cash" })).toMatchObject({ reason: "invalid", fields: ["kind"] });
    expect(await invalid({ foodType: "pork" })).toMatchObject({ reason: "invalid" });
    expect(await invalid({ slotId: page.slots[1].id })).toMatchObject({ reason: "invalid" });
    expect(await invalid({ cancelledAt: null })).toMatchObject({ reason: "invalid" });
    expect(await invalid({ firstName: "Da\u0000na" })).toMatchObject({ reason: "invalid" });
    expect(await signUpForMeal(db, page.publicToken, slot, "Dana", meta(), NOW)).toMatchObject({ reason: "invalid" });
    // Refusals name fields, never values.
    expect(JSON.stringify(await invalid({ email: "secret-value" }))).not.toContain("secret-value");

    const bot = (m: unknown) => signUpForMeal(db, page.publicToken, slot, helper(), m, NOW);
    expect(await bot({ clientKey: "203.0.113.1", honeypot: "http://spam.example", elapsedMs: 9_000 })).toEqual({ ok: false, reason: "refused" });
    expect(await bot({ clientKey: "203.0.113.2", honeypot: "", elapsedMs: 300 })).toEqual({ ok: false, reason: "refused" });
    expect(await bot({ clientKey: "203.0.113.3", honeypot: "" })).toEqual({ ok: false, reason: "refused" });
    expect(await bot({ honeypot: "" })).toMatchObject({ reason: "invalid", fields: ["clientMeta"] });
    expect(await bot(undefined)).toMatchObject({ reason: "invalid" });
    expect(await db.select().from(mealSignups)).toHaveLength(0);

    const ok = await signUpForMeal(db, page.publicToken, slot, { firstName: "  Dana ", lastName: "Levy", email: " Dana@Example.TEST ", kind: "delivery" }, meta(), NOW);
    expect(ok.ok).toBe(true);
    expect((await db.select().from(mealSignups))[0]).toMatchObject({ firstName: "Dana", email: "dana@example.test", kind: "delivery", foodType: "not_sure", bringing: null, note: null, mayContactAgain: false });
  });
});

describe("the helper's own link", () => {
  it("shows the private details, changes what is being brought, and moves to another open date atomically", async () => {
    const mine = await signUp(0);
    const other = await signUp(1, { firstName: "Eli", email: "eli@example.test" });
    const before = await getMySignup(db, mine.manageToken, NOW);
    if (before?.state !== "active") throw new Error("not active");
    expect(before.details).toMatchObject({ dropOffAddress: ADDRESS, dropOffInstructions: INSTRUCTIONS, dropOffWindow: "5 to 6 pm", date: "2026-12-01" });
    expect(before).toMatchObject({ firstName: "Dana", bringing: "Lasagne", foodType: "dairy", note: "See you at six", thanks: null, openDates: [{ slotId: page.slots[2].id, date: "2026-12-05", meal: "dinner" }] });
    expect(words(before)).not.toMatch(/eli|Levy|@example|token/i);

    const changed = await changeMySignup(db, mine.manageToken, { bringing: "Brisket", foodType: "meat", note: "" }, meta(), NOW);
    expect(changed).toMatchObject({ ok: true, signup: { state: "active", bringing: "Brisket", foodType: "meat", note: null, details: { date: "2026-12-01" } } });

    // To a night someone else has: refused, and nothing moves.
    expect(await changeMySignup(db, mine.manageToken, { moveToSlotId: page.slots[1].id, bringing: "Kugel" }, meta(), NOW)).toEqual({ ok: false, reason: "taken" });
    expect(await getMySignup(db, mine.manageToken, NOW)).toMatchObject({ bringing: "Brisket", details: { date: "2026-12-01" } });
    // To a past date, a date on another page, or nonsense: refused.
    const elsewhere = await livePage(db, t.lead);
    expect(await changeMySignup(db, mine.manageToken, { moveToSlotId: elsewhere.slots[1].id }, meta(), NOW)).toEqual({ ok: false, reason: "unavailable" });
    expect(await changeMySignup(db, other.manageToken, { moveToSlotId: page.slots[0].id }, meta(), new Date("2026-12-02T18:00:00Z"))).toMatchObject({ ok: false });
    expect(await changeMySignup(db, mine.manageToken, { moveToSlotId: "nope" }, meta(), NOW)).toMatchObject({ reason: "invalid", fields: ["moveToSlotId"] });
    expect(await changeMySignup(db, mine.manageToken, { email: "new@example.test" }, meta(), NOW)).toMatchObject({ reason: "invalid" });

    const moved = await changeMySignup(db, mine.manageToken, { moveToSlotId: page.slots[2].id }, meta(), NOW);
    expect(moved).toMatchObject({ ok: true, signup: { details: { date: "2026-12-05" }, bringing: "Brisket", openDates: [{ date: "2026-12-01" }] } });
    const pub = await getPublicMealPage(db, page.publicToken, NOW);
    expect(pub?.status === "live" && pub.dates.map((d) => d.taken?.firstName ?? null)).toEqual([null, "Eli", "Dana"]);
    expect(await db.select().from(mealSignups)).toHaveLength(2);
  });

  it("cancels, which opens the night again and takes the address away", async () => {
    const mine = await signUp(0);
    expect(await cancelMySignup(db, mine.manageToken, meta(), NOW)).toEqual({ ok: true });
    expect(await cancelMySignup(db, mine.manageToken, meta(), NOW)).toEqual({ ok: true });
    const after = await getMySignup(db, mine.manageToken, NOW);
    expect(after).toEqual({ state: "cancelled", title: "the Cohen family", date: "2026-12-01", meal: "dinner", thanks: null });
    expect(await changeMySignup(db, mine.manageToken, { bringing: "x" }, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    expect(await mealSignupIcs(db, mine.manageToken, NOW)).toBeNull();
    expect((await db.select().from(mealSignups))[0]).toMatchObject({ cancelledBy: "helper", cancelledAt: NOW });
    expect((await signUp(0, { firstName: "Eli", email: "eli@example.test" })).details.date).toBe("2026-12-01");
  });

  it("gives no address once the page is paused or ended, the date withdrawn, or the helper removed", async () => {
    const [a, b, c] = [await signUp(0), await signUp(1, { email: "b@example.test" }), await signUp(2, { email: "c@example.test" })];
    await withdrawDate(db, t.clergy, page.id, page.slots[1].id, NOW);
    await removeSignup(db, t.clergy, page.id, c.signupId, {}, NOW);
    expect(await getMySignup(db, b.manageToken, NOW)).toMatchObject({ state: "withdrawn" });
    expect(await getMySignup(db, c.manageToken, NOW)).toMatchObject({ state: "cancelled" });
    await pauseMealPage(db, t.clergy, page.id, NOW);
    expect(await getMySignup(db, a.manageToken, NOW)).toEqual({ state: "paused", title: "the Cohen family", date: "2026-12-01", meal: "dinner", thanks: null });
    await endMealPage(db, t.clergy, page.id, NOW);
    for (const token of [a.manageToken, b.manageToken, c.manageToken]) {
      const view = await getMySignup(db, token, NOW);
      expect(Object.keys(view!).sort()).toEqual(["date", "meal", "state", "thanks", "title"]);
      expect(words(view)).not.toMatch(/Maple|porch/);
      expect(await mealSignupIcs(db, token, NOW)).toBeNull();
    }
    expect(await getMySignup(db, a.manageToken, NOW)).toMatchObject({ state: "ended" });
  });

  it("the calendar file has the title, date, window and address, and nothing about the household's needs", async () => {
    const mine = await signUp(1);
    const ics = (await mealSignupIcs(db, mine.manageToken, NOW))!;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("SUMMARY:Mitzvah Meals: dinner for the Cohen family\r\n");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261203\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261204\r\n");
    expect(ics).toContain("LOCATION:12 Maple Lane\\, St. Louis\r\n");
    expect(ics).toContain("DESCRIPTION:Drop-off: 5 to 6 pm\r\n");
    expect(ics).toContain(`UID:${mine.signupId}@`);
    for (const leak of ["Peanuts", "nut free", "kosher", "porch", "adults", "Levy", "@example", SECRET, "Thank you"]) expect(ics, leak).not.toContain(leak);
    // An address cannot break out of its line, and long lines are folded.
    const tricky = await livePage(db, t.lead, { dropOffAddress: `1 Long Road; Apt 2\nEND:VEVENT ${"x".repeat(120)}` });
    const signed = await signUp(0, {}, tricky);
    const folded = (await mealSignupIcs(db, signed.manageToken, NOW))!;
    expect(folded.match(/END:VEVENT/g)).toHaveLength(2); // one escaped inside LOCATION, one real
    expect(folded).toContain("LOCATION:1 Long Road\\; Apt 2\\nEND:VEVENT");
    expect(folded.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });
});

describe("the family's link", () => {
  it("shows tonight first and who is coming, by name, without any email or link", async () => {
    const tonight = await signUp(0);
    await signUp(2, { firstName: "Eli", lastName: "Stein", email: "eli@example.test" });
    const view = (await getFamilyView(db, page.familyToken, NOW))!;
    if (view.status === "ended") throw new Error("ended");
    expect(Object.keys(view).sort()).toEqual(["allergies", "canResume", "dates", "dietary", "dropOffInstructions", "dropOffWindow", "foodFor", "kashrut", "status", "title", "today", "tonight"]);
    expect(view.tonight).toEqual([{ slotId: page.slots[0].id, date: "2026-12-01", meal: "dinner", past: false, helper: { signupId: tonight.signupId, firstName: "Dana", lastName: "Levy", kind: "cook", bringing: "Lasagne", foodType: "dairy", note: "See you at six", thanked: false } }]);
    expect(view.dates.map((d) => d.helper?.firstName ?? null)).toEqual(["Dana", null, "Eli"]);
    const text = JSON.stringify(view);
    for (const leak of ["@", "email", "oken", page.publicToken, tonight.manageToken, SECRET, "illness", t.clergy.id, "organiser", "Pi Pizzeria"]) expect(text, leak).not.toContain(leak);
  });

  it("changes the food needs and drop-off window and instructions, and nothing else", async () => {
    const ok = await updateFoodNeeds(db, page.familyToken, { allergies: "Peanuts and sesame", kashrut: "vegetarian_or_dairy", dietary: ["Vegetarian"], dropOffWindow: "after 4", dropOffInstructions: "", foodFor: "5" }, meta(), NOW);
    expect(ok).toMatchObject({ ok: true, view: { allergies: "Peanuts and sesame", kashrut: "vegetarian_or_dairy", dietary: ["vegetarian"], dropOffWindow: "after 4", dropOffInstructions: null, foodFor: "5" } });
    const before = await getMealPageForOrganiser(db, t.clergy, page.id, NOW);
    for (const bad of [{ title: "x" }, { note: "x" }, { dropOffAddress: "1 Elsewhere" }, { dropOffIsHome: false }, { status: "ended" }, { giftCards: "x" }, { giftCardEmail: "a@b.co" }, { deliveryPlaces: "x" }, { familyAgreedAt: null }, { organiserUserId: t.lead.id }, { careItemId: null }, { allergies: "ok", title: "smuggled" }, { allergies: "x".repeat(501) }])
      expect(await updateFoodNeeds(db, page.familyToken, bad, meta(), NOW), JSON.stringify(bad)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await getMealPageForOrganiser(db, t.clergy, page.id, NOW)).toEqual(before);
    // The public page shows the change at once.
    expect(await getPublicMealPage(db, page.publicToken, NOW)).toMatchObject({ allergies: "Peanuts and sesame" });
  });

  it("pauses, resumes and ends the page, and thanks a helper, who sees it on their own link", async () => {
    const mine = await signUp(0);
    expect(await familyPause(db, page.familyToken, meta(), NOW)).toMatchObject({ ok: true, view: { status: "paused" } });
    expect(await familyPause(db, page.familyToken, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    expect(await getPublicMealPage(db, page.publicToken, NOW)).toEqual({ status: "paused", title: "the Cohen family" });
    expect(await familyResume(db, page.familyToken, meta(), NOW)).toMatchObject({ ok: true, view: { status: "live" } });

    expect(await thankHelper(db, page.familyToken, mine.signupId, "x".repeat(301), meta(), NOW)).toMatchObject({ reason: "invalid" });
    const other = await livePage(db, t.lead);
    const theirs = await signUp(0, {}, other);
    expect(await thankHelper(db, page.familyToken, theirs.signupId, "Thank you", meta(), NOW)).toEqual({ ok: false, reason: "unavailable" });
    const thanked = await thankHelper(db, page.familyToken, mine.signupId, "  The soup was wonderful  ", meta(), NOW);
    expect(thanked).toMatchObject({ ok: true, view: { tonight: [{ helper: { thanked: true } }] } });
    expect(await getMySignup(db, mine.manageToken, NOW)).toMatchObject({ state: "active", thanks: { text: "The soup was wonderful", at: NOW } });
    expect(await getMySignup(db, theirs.manageToken, NOW)).toMatchObject({ thanks: null });

    expect(await familyEnd(db, page.familyToken, meta(), NOW)).toMatchObject({ ok: true, view: { status: "ended" } });
    expect(await updateFoodNeeds(db, page.familyToken, { allergies: "x" }, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    expect(await familyResume(db, page.familyToken, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    // The thanks still reaches the helper after the page has ended.
    expect(await getMySignup(db, mine.manageToken, NOW)).toMatchObject({ state: "ended", thanks: { text: "The soup was wonderful" } });
    // A draft is not the family's to take live or to end.
    const draft = await createMealPage(db, t.lead, pageInput(), NOW);
    expect(await familyResume(db, draft.familyToken, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    expect(await familyEnd(db, draft.familyToken, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
  });
});

describe("abuse limits", () => {
  it("one client gets a few sign-up attempts an hour, whatever they send; other clients are unaffected", async () => {
    const pest = "203.0.113.50";
    const attempt = (key: string, token: unknown = page.publicToken) => signUpForMeal(db, token, page.slots[0].id, helper({ email: "not-an-email" }), meta(key), NOW);
    for (let i = 0; i < LIMITS.signupPerClient; i++) expect(await attempt(pest, i % 2 ? "wrong-token" : page.publicToken)).not.toMatchObject({ reason: "rate_limited" });
    expect(await attempt(pest)).toEqual({ ok: false, reason: "rate_limited" });
    // Even a guess at a token is refused the same way once over the limit.
    expect(await attempt(pest, "wrong-token")).toEqual({ ok: false, reason: "rate_limited" });
    expect(await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(pest), NOW)).toEqual({ ok: false, reason: "rate_limited" });
    expect((await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta("203.0.113.51"), NOW)).ok).toBe(true);
    // The next hour is a new window.
    expect((await signUpForMeal(db, page.publicToken, page.slots[1].id, helper(), meta(pest), new Date(NOW.getTime() + 3_600_000))).ok).toBe(true);
    // No address is stored: only a short-lived hash.
    expect(JSON.stringify(await db.select().from(mealRateLimits))).not.toContain("203.0.113");
  });

  it("a page takes only so many sign-up attempts an hour from everyone together", async () => {
    await db.insert(mealRateLimits).values({ key: `signup:page:${page.id}`, windowStart: new Date("2026-12-01T18:00:00Z"), count: LIMITS.signupPerPage });
    expect(await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(), NOW)).toEqual({ ok: false, reason: "rate_limited" });
    const other = await livePage(db, t.lead);
    expect((await signUpForMeal(db, other.publicToken, other.slots[0].id, helper(), meta(), NOW)).ok).toBe(true);
  });

  it("manage and family links are limited per client too, and the counters prune themselves", async () => {
    const mine = await signUp(0);
    const key = "203.0.113.60";
    for (let i = 0; i < LIMITS.managePerClient; i++) await changeMySignup(db, mine.manageToken, { bringing: `dish ${i}` }, meta(key), NOW);
    expect(await changeMySignup(db, mine.manageToken, { bringing: "one more" }, meta(key), NOW)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await cancelMySignup(db, mine.manageToken, meta(key), NOW)).toEqual({ ok: false, reason: "rate_limited" });
    for (let i = 0; i < LIMITS.familyPerClient; i++) await updateFoodNeeds(db, page.familyToken, { foodFor: `${i}` }, meta(key), NOW);
    expect(await familyEnd(db, page.familyToken, meta(key), NOW)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await getPublicMealPage(db, page.publicToken, NOW)).toMatchObject({ status: "live" });

    expect(await withinLimit(db, "k", 2, NOW)).toBe(true);
    expect(await withinLimit(db, "k", 2, NOW)).toBe(true);
    expect(await withinLimit(db, "k", 2, NOW)).toBe(false);
    expect(await withinLimit(db, "k", 2, new Date(NOW.getTime() + 3 * 3_600_000))).toBe(true);
    expect(await db.select().from(mealRateLimits)).toHaveLength(1);
  });
});

describe("retention", () => {
  it("thirty days after a page ended, only helpers who opted in keep a name and an email", async () => {
    const forgotten = await signUp(0);
    const kept = await signUp(1, { firstName: "Eli", lastName: "Stein", email: "eli@example.test", mayContactAgain: true });
    const removed = await signUp(2, { firstName: "Pat", email: "pest@example.test" });
    await removeSignup(db, t.clergy, page.id, removed.signupId, { blockEmail: true }, NOW);
    await thankHelper(db, page.familyToken, kept.signupId, "Thank you Eli", meta(), NOW);
    const recent = await livePage(db, t.lead);
    const recentSignup = await signUp(0, {}, recent);
    await endMealPage(db, t.clergy, page.id, NOW);
    await endMealPage(db, t.lead, recent.id, new Date(NOW.getTime() + 5 * 86_400_000));
    const stillLive = await livePage(db, t.lead);
    await signUp(0, {}, stillLive);

    const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
    expect(await purgeMealData(db, day(29))).toEqual({ pages: 0, signups: 0 });
    expect(await db.select().from(mealPageBlocks)).toHaveLength(1);
    expect(await purgeMealData(db, day(31))).toEqual({ pages: 1, signups: 3 });

    const rows = Object.fromEntries((await db.select().from(mealSignups)).map((r) => [r.id, r]));
    expect(rows[forgotten.signupId]).toMatchObject({ firstName: null, lastName: null, email: null, note: null, thanksText: null, bringing: null, purgedAt: day(31) });
    expect(rows[removed.signupId]).toMatchObject({ firstName: null, lastName: null, email: null, note: null, bringing: null });
    expect(rows[kept.signupId]).toMatchObject({ firstName: "Eli", lastName: "Stein", email: "eli@example.test", note: null, thanksText: null, bringing: null });
    expect(rows[recentSignup.signupId]).toMatchObject({ firstName: "Dana", email: "dana.levy@example.test", note: "See you at six", bringing: "Lasagne", purgedAt: null });
    expect(Object.values(rows).filter((r) => r.email !== null)).toHaveLength(3);
    expect(await db.select().from(mealPageBlocks)).toHaveLength(0);
    // Running it again changes nothing; later the other ended page falls due, and a live page never does.
    expect(await purgeMealData(db, day(32))).toEqual({ pages: 0, signups: 0 });
    expect(await purgeMealData(db, day(36))).toEqual({ pages: 1, signups: 1 });
    expect(await purgeMealData(db, day(400))).toEqual({ pages: 0, signups: 0 });
    expect((await db.select().from(mealSignups).where(isNull(mealSignups.purgedAt))).map((r) => r.firstName)).toEqual(["Dana"]);
  });
});

describe("the audit trail", () => {
  it("records every change with ids, enums and flags only: no names, emails, words or tokens", async () => {
    const a = await signUp(0);
    await thankHelper(db, page.familyToken, a.signupId, "The soup was wonderful", meta(), NOW);
    await updateFoodNeeds(db, page.familyToken, { allergies: "Sesame seeds", dropOffInstructions: "Ring twice" }, meta(), NOW);
    await familyPause(db, page.familyToken, meta(), NOW);
    await familyResume(db, page.familyToken, meta(), NOW);
    await removeSignup(db, t.clergy, page.id, a.signupId, { blockEmail: true }, NOW);
    await familyEnd(db, page.familyToken, meta(), NOW);

    const rows = (await db.select().from(auditLog)).filter((r) => r.action.startsWith("meal_"));

    expect(rows.map((r) => r.action).sort()).toEqual(["meal_page.block_email", "meal_page.create", "meal_page.end", "meal_page.family_change", "meal_page.family_change", "meal_page.go_live", "meal_page.pause", "meal_page.resume", "meal_signup.create", "meal_signup.remove"]);
    const byHelper = rows.filter((r) => (r.detail as { by?: string }).by === "helper");
    expect(byHelper).toMatchObject([{ actorUserId: null, action: "meal_signup.create", subjectType: "meal_signup", subjectId: a.signupId, detail: { mealPageId: page.id, slotId: page.slots[0].id } }]);
    const byFamily = rows.filter((r) => (r.detail as { by?: string }).by === "family");
    expect(byFamily.map((r) => r.action).sort()).toEqual(["meal_page.end", "meal_page.family_change", "meal_page.family_change", "meal_page.pause", "meal_page.resume"]);
    expect(byFamily.every((r) => r.actorUserId === null && r.subjectId === page.id)).toBe(true);
    expect(rows.filter((r) => r.actorUserId !== null).every((r) => r.actorUserId === (t.clergy as Actor).id)).toBe(true);
    expect(byFamily.map((r) => (r.detail as { fields?: string[] }).fields).filter(Boolean)).toEqual(expect.arrayContaining([["thanks"], ["allergies", "dropOffInstructions"]]));

    const WORDS = new Set(["organiser", "family", "helper", "foodFor", "kashrut", "dietary", "allergies", "dropOffWindow", "dropOffInstructions", "thanks"]);
    const KEYS = new Set(["by", "fields", "blocked", "mealPageId", "slotId"]);
    for (const row of rows) {
      for (const [key, value] of Object.entries(row.detail as Record<string, unknown>)) {
        expect(KEYS.has(key), key).toBe(true);
        for (const v of Array.isArray(value) ? value : [value]) expect(typeof v === "boolean" || isUuid(v) || WORDS.has(v as string), `${row.action} ${key}`).toBe(true);
      }
    }
    const text = JSON.stringify(rows);
    for (const leak of ["Dana", "Levy", "@example", "soup", "Sesame", "Ring twice", "Cohen", "Maple", page.publicToken, page.familyToken, a.manageToken]) expect(text, leak).not.toContain(leak);
  });
});
