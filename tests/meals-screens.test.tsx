import { LIMITS } from "@/server/meals/rate-limit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import type { Db } from "@/server/db/types";
import { signRenderStamp } from "@/server/meals/client-meta";
import { createMealPage, markFamilyAgreed, pauseMealPage } from "@/server/meals/pages";
import { familyPause } from "@/server/meals/family";
import { signUpForMeal } from "@/server/meals/public";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { ADDRESS, helper, INSTRUCTIONS, livePage, meta, NOW, pageInput, type LivePage } from "./support/meals";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-vercel-forwarded-for": "203.0.113.50" }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/meals" }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { cancelSignupAction, signUpAction, thankHelperAction, type SignupState } from "@/app/m/actions";
import MealsListPage from "@/app/meals/page";
import MealsPageRoute from "@/app/meals/[id]/page";
import FlyerPage from "@/app/meals/[id]/flyer/page";
import NewMealsPage from "@/app/meals/new/page";
import FamilyPage from "@/app/m/f/[token]/page";
import PublicMealsPage, { generateMetadata } from "@/app/m/[token]/page";
import MySignupPage from "@/app/m/s/[manageToken]/page";
import { GET as calendarFile } from "@/app/m/s/[manageToken]/calendar.ics/route";
import { QrCode } from "@/components/meals/qr";
import { loadMealsLine, PersonMeals } from "@/components/meals/person-meals";
import { navItems } from "@/components/shell/app-shell";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
let page: LivePage;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const p = <T,>(v: T) => Promise.resolve(v);
const publicPage = (token: string, query: { night?: string } = {}) => html(PublicMealsPage({ params: p({ token }), searchParams: p(query) }));

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-meal-screens";
  process.env.BETTER_AUTH_URL = "https://care.example.test";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

beforeEach(async () => {
  db = await testDb();
  state.db = db;
  t = { ...(await team(db)), ...(await reporters(db)) };
  page = await livePage(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT });
});

const notFound = { digest: expect.stringContaining("404") };
const redirects = (to: string) => ({ digest: expect.stringContaining(to) });

describe("the public page", () => {
  it("is a list of evenings with the open ones loudest, and shows nothing private", async () => {
    await signUpForMeal(db, page.publicToken, page.slots[1].id, helper({ lastName: "Levy" }), meta(), NOW);
    const out = await publicPage(page.publicToken);
    expect(out).toContain("Mitzvah Meals for the Cohen family");
    expect(out).toContain("Central Reform Congregation");
    expect(out.match(/data-testid="night-open"/g)).toHaveLength(2);
    expect(out.match(/data-testid="night-taken"/g)).toHaveLength(1);
    // The taken night shows a first name and a dish, and the Hebrew date faces each date.
    expect(out).toContain("Dana is bringing: Lasagne");
    expect(out).toContain('lang="he"');
    // Allergies stand apart from preferences, and kashrut is in plain words.
    expect(out).toContain('data-testid="allergies"');
    expect(out).toContain("Peanuts");
    expect(out).toContain("Kosher style: no pork or shellfish, no meat with dairy");
    // No account, no menu, no form until a night is chosen, and none of what only a helper may know.
    expect(out).not.toContain("<form");
    expect(out).not.toContain('aria-label="Main"');
    for (const secret of [ADDRESS, INSTRUCTIONS, "Levy", "dana.levy", "illness", "restricted"]) expect(out, secret).not.toContain(secret);
    expect(out).not.toMatch(/\$|donate|payment/i);
  });

  it("opens the one-step sign-up on a chosen night, with a signed stamp and a hidden honeypot", async () => {
    const out = await publicPage(page.publicToken, { night: page.slots[0].id });
    expect(out).toContain('data-testid="signup-form"');
    expect(out).toContain('name="stamp"');
    const honeypot = out.match(/<input[^>]*name="website"[^>]*>/)?.[0] ?? "";
    expect(honeypot).toContain('tabindex="-1"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("You may ask me again for another family");
    for (const name of ["firstName", "lastName", "email", "bringing", "foodType", "note", "kind"]) expect(out, name).toContain(`name="${name}"`);
    // The allergies are repeated on the sign-up step.
    expect(out.split('data-testid="allergies"').length - 1).toBe(2);
    // A night that is not open, or from another page, does not open the form.
    expect(await publicPage(page.publicToken, { night: "not-a-night" })).not.toContain("<form");
  });

  it("says so kindly when every night is taken", async () => {
    for (const s of page.slots) await signUpForMeal(db, page.publicToken, s.id, helper({ email: `h${s.id.slice(0, 4)}@example.test` }), meta(), NOW);
    const out = await publicPage(page.publicToken);
    expect(out).toContain('data-testid="all-covered"');
    expect(out).toContain("All covered. Gift cards still help.");
  });

  it("shows only a kind line and the title when the page is paused, and not found for an unknown link", async () => {
    await pauseMealPage(db, t.clergy, page.id, NOW);
    const out = await publicPage(page.publicToken);
    expect(out).toContain('data-testid="not-open"');
    expect(out).toContain("Mitzvah Meals for the Cohen family");
    for (const hidden of ["Peanuts", "night-open", "Lasagne", "<form"]) expect(out).not.toContain(hidden);
    await expect(publicPage("nonsense-token")).rejects.toMatchObject(notFound);
  });

  it("its link preview carries the title only: no description, no image, not indexed", async () => {
    const m = await generateMetadata({ params: p({ token: page.publicToken }) });
    expect(m.title).toBe("Mitzvah Meals for the Cohen family · Central Reform Congregation");
    expect(m.description).toBeNull();
    expect(m.robots).toMatchObject({ index: false, follow: false });
    expect(m.referrer).toBe("no-referrer");
    expect(m.openGraph).toMatchObject({ title: m.title });
    expect(m.openGraph).not.toHaveProperty("images");
    expect(words(m)).not.toMatch(/Peanuts|Maple|illness/);
    expect((await generateMetadata({ params: p({ token: "nonsense" }) })).title).toBe("Mitzvah Meals · Central Reform Congregation");
  });
});

function signupForm(over: Record<string, string> = {}, stampAge = 10_000): FormData {
  const form = new FormData();
  const values: Record<string, string> = { token: page.publicToken, slotId: page.slots[0].id, stamp: signRenderStamp(page.publicToken, new Date(NOW.getTime() - stampAge)), website: "", firstName: "Dana", lastName: "Levy", email: "dana@example.test", kind: "cook", bringing: "Lasagne", foodType: "dairy", note: "", ...over };
  for (const [k, v] of Object.entries(values)) form.set(k, v);
  return form;
}
const idle: SignupState = { status: "idle" };

describe("signing up", () => {
  it("sends a real sign-up to the helper's own page", async () => {
    await expect(signUpAction(idle, signupForm())).rejects.toMatchObject(redirects("/m/s/"));
    const out = await publicPage(page.publicToken);
    expect(out).toContain("Dana is bringing");
  });

  it("answers every refusal in plain words and keeps the reason", async () => {
    // A form that was not rendered by us a short while ago: forged, missing or moved timestamps.
    expect(await signUpAction(idle, signupForm({ stamp: `${NOW.getTime() - 60_000}.forged` }))).toMatchObject({ status: "error", reason: "stale" });
    expect(await signUpAction(idle, signupForm({ stamp: "" }))).toMatchObject({ status: "error", reason: "stale" });
    // Too quick to be a person, or the hidden field filled in.
    expect(await signUpAction(idle, signupForm({}, 500))).toMatchObject({ status: "error", reason: "refused" });
    expect(await signUpAction(idle, signupForm({ website: "http://spam.example" }))).toMatchObject({ status: "error", reason: "refused" });
    // Field errors name the fields, never their values.
    const invalid = await signUpAction(idle, signupForm({ email: "not an email" }));
    expect(invalid).toMatchObject({ status: "error", reason: "invalid", fields: ["email"] });
    expect(JSON.stringify(invalid)).not.toContain("not an email");
    // A night that is not on the page, then a night someone has just taken.
    expect(await signUpAction(idle, signupForm({ slotId: "00000000-0000-4000-8000-000000000000" }))).toMatchObject({ status: "error", reason: "unavailable" });
    await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ email: "first@example.test" }), meta(), NOW);
    expect(await signUpAction(idle, signupForm())).toMatchObject({ status: "error", reason: "taken" });
    // A closed page.
    await pauseMealPage(db, t.clergy, page.id, NOW);
    expect(await signUpAction(idle, signupForm({ slotId: page.slots[1].id }))).toMatchObject({ status: "error", reason: "closed" });
    // A link that matches nothing (two hours on: this client has used its tries for the hour).
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    expect(await signUpAction(idle, signupForm({ token: "nonsense", stamp: signRenderStamp("nonsense", new Date(NOW.getTime() - 10_000)) }))).toMatchObject({ status: "error", reason: "not_found" });
    vi.setSystemTime(NOW);
  });

  it("holds one client to the sign-up limit, by the address the platform reports", async () => {
    let last: SignupState = idle;
    for (let i = 0; i < LIMITS.signupPerClient + 2; i++) last = await signUpAction(idle, signupForm({ email: "nope" }));
    expect(last).toMatchObject({ status: "error", reason: "rate_limited" });
  });
});

describe("a helper's own page", () => {
  async function mine() {
    const result = await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(), NOW);
    if (!result.ok) throw new Error("refused");
    return result.manageToken;
  }

  it("confirms the address, window and instructions, offers the calendar file and the link, and lets them change or cancel", async () => {
    const token = await mine();
    const out = await html(MySignupPage({ params: p({ manageToken: token }), searchParams: p({ new: "1" }) }));
    expect(out).toContain('data-testid="signup-confirmation"');
    expect(out).toContain(ADDRESS);
    expect(out).toContain("5 to 6 pm");
    expect(out).toContain(INSTRUCTIONS);
    expect(out).toContain(`/m/s/${token}/calendar.ics`);
    expect(out).toContain("Copy my link");
    expect(out).toContain("Save changes");
    expect(out).toContain("Cancel my night");
    // Everything a helper needs to know before cooking is repeated for them.
    expect(out).toContain('data-testid="allergies"');
    await expect(html(MySignupPage({ params: p({ manageToken: "nonsense" }), searchParams: p({}) }))).rejects.toMatchObject(notFound);
  });

  it("serves the calendar file as text/calendar, and not found for a wrong link", async () => {
    const token = await mine();
    const res = await calendarFile(new Request("http://x"), { params: p({ manageToken: token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("Maple");
    expect(body).not.toContain("Peanuts");
    expect((await calendarFile(new Request("http://x"), { params: p({ manageToken: "nonsense" }) })).status).toBe(404);
  });

  it("cancels, and then says so", async () => {
    const token = await mine();
    const form = new FormData();
    form.set("token", token);
    expect(await cancelSignupAction({ status: "idle" }, form)).toMatchObject({ status: "ok" });
    const out = await html(MySignupPage({ params: p({ manageToken: token }), searchParams: p({}) }));
    expect(out).toContain('data-testid="signup-state"');
    expect(out).not.toContain(ADDRESS);
  });
});

describe("the family's link", () => {
  it("shows tonight first, then the week, the food needs and a way to pause or end", async () => {
    await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(), NOW);
    const out = await html(FamilyPage({ params: p({ token: page.familyToken }) }));
    expect(out.indexOf("Tonight")).toBeGreaterThan(-1);
    expect(out.indexOf("Tonight")).toBeLessThan(out.indexOf("The week"));
    expect(out).toContain("Dana Levy is bringing: Lasagne");
    expect(out).toContain("Food needs");
    expect(out).toContain("Pause the page");
    expect(out).toContain("End the page");
    expect(out).not.toContain("dana.levy");
    await expect(html(FamilyPage({ params: p({ token: page.publicToken }) }))).rejects.toMatchObject(notFound);
  });

  it("offers to open the page again only when the family paused it", async () => {
    await familyPause(db, page.familyToken, meta(), NOW);
    expect(await html(FamilyPage({ params: p({ token: page.familyToken }) }))).toContain("Open the page again");
    const other = await livePage(db, t.clergy, { title: "the Levy family" });
    await pauseMealPage(db, t.clergy, other.id, NOW);
    const out = await html(FamilyPage({ params: p({ token: other.familyToken }) }));
    expect(out).toContain('data-testid="paused"');
    expect(out).not.toContain("Open the page again");
  });

  it("thanks a helper", async () => {
    const result = await signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(), NOW);
    if (!result.ok) throw new Error("refused");
    const form = new FormData();
    form.set("token", page.familyToken);
    form.set("signupId", result.signupId);
    form.set("text", "Thank you, it was delicious");
    expect(await thankHelperAction({ status: "idle" }, form)).toMatchObject({ status: "ok" });
    const out = await html(MySignupPage({ params: p({ manageToken: result.manageToken }), searchParams: p({}) }));
    expect(out).toContain("Thank you, it was delicious");
  });
});

describe("the organiser's screens", () => {
  it("lists pages with their open nights, and refuses those who may not run pages", async () => {
    as(t.clergy);
    const out = await html(MealsListPage());
    expect(out).toContain('data-testid="meals-row"');
    expect(out).toContain("3 open nights");
    as(t.senior);
    expect(await html(MealsListPage())).toContain("do not have access");
    as(t.carer);
    expect(await html(MealsListPage())).toContain("do not have access");
    state.viewer = { kind: "signed-out" };
    await expect(MealsListPage()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });

  it("leads a live page with its open nights and the share kit", async () => {
    as(t.clergy);
    const out = await html(MealsPageRoute({ params: p({ id: page.id }) }));
    expect(out).toMatch(/data-testid="open-count"[^>]*>3 open nights/);
    expect(out).toContain("Copy the link");
    expect(out).toContain("Text it");
    expect(out).toContain("Print a flyer");
    expect(decodeURIComponent(out)).toContain(`/m/${page.publicToken}`);
    expect(out).toContain("Edit the page");
    expect(out).toContain("Choose more nights");
    // Candle-lighting beside a Friday's drop-off.
    const friday = await createMealPage(db, t.clergy, pageInput({ dates: [{ date: "2026-12-04" }] }), NOW);
    expect(await html(MealsPageRoute({ params: p({ id: friday.id }) }))).toMatch(/Shabbat|Candle lighting/);
  });

  it("shows a page to its organiser and not found to a staff member who is not one", async () => {
    const mine = await livePage(db, t.staff, { title: "the Katz family" });
    as(t.staff);
    expect(await html(MealsPageRoute({ params: p({ id: mine.id }) }))).toContain("Katz");
    await expect(MealsPageRoute({ params: p({ id: page.id }) })).rejects.toMatchObject(notFound);
  });

  it("keeps a draft draft until the family has agreed", async () => {
    as(t.clergy);
    const draft = await createMealPage(db, t.clergy, pageInput(), NOW);
    expect(await html(MealsPageRoute({ params: p({ id: draft.id }) }))).toContain("The family has said yes");
    await markFamilyAgreed(db, t.clergy, draft.id, NOW);
    expect(await html(MealsPageRoute({ params: p({ id: draft.id }) }))).toContain("Go live");
  });

  it("prints a flyer with an inline QR code of the public link", async () => {
    as(t.clergy);
    const out = await html(FlyerPage({ params: p({ id: page.id }) }));
    expect(out).toContain("<svg");
    expect(out).toContain(`https://care.example.test/m/${page.publicToken}`);
    expect(out).toContain("Mitzvah Meals for the Cohen family");
    expect(out).not.toMatch(/Maple|Peanuts|<img|<script/);
  });

  it("sets a page up asking for the household, the nights and the family's yes, with every other night chosen", async () => {
    as(t.clergy);
    const out = await html(NewMealsPage({ searchParams: p({}) }));
    expect(out).toContain("Which household?");
    expect(out).toContain("Which nights?");
    expect(out).toContain("The family has said yes to this page");
    expect(out.match(/name="date"/g)).toHaveLength(11);
    expect(out).toContain("A dot marks Shabbat and holidays");
    // From a care item or outside person the household is already chosen.
    const fromOutside = await html(NewMealsPage({ searchParams: p({ outside: "00000000-0000-4000-8000-000000000000" }) }));
    expect(fromOutside).toContain("could not be found");
  });
});

describe("integration", () => {
  it("Mitzvah Meals is in the menu for the roles that may run pages, and for no one else", () => {
    for (const a of [t.owner, t.clergy, t.staff, t.lead]) expect(navItems(a).map((i) => i.href), a.role).toContain("/meals");
    for (const a of [t.carer, t.senior]) expect(navItems(a).map((i) => i.href), a.role).not.toContain("/meals");
  });

  it("a person's page carries a meals line for clergy, with a way to start a page", async () => {
    const lines = await loadMealsLine(t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT });
    const out = renderToStaticMarkup(<PersonMeals actor={t.clergy} lines={lines} startHref={`/meals/new?contact=${CONTACT}`} />);
    expect(out).toContain('data-testid="meals-line"');
    expect(out).toContain("the Cohen family");
    expect(out).toContain("3 open nights");
    expect(out).toContain("Start a Mitzvah Meals page");
    expect(await loadMealsLine(t.carer, { sfContactId: CONTACT })).toBeNull();
  });

  it("the QR code is inline SVG made here, labelled for a screen reader", () => {
    const out = renderToStaticMarkup(<QrCode text="https://care.example.test/m/abc" label="QR code for a page" />);
    expect(out).toContain("<svg");
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="QR code for a page"');
    expect(out).toContain("<path");
    expect(out).not.toMatch(/<img|href=/);
  });
});
