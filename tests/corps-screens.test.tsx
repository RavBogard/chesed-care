import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { corpsMembers } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { signRenderStamp } from "@/server/meals/client-meta";
import { createVolunteerSeries } from "@/server/volunteers/series";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { claimTask } from "@/server/volunteers/public";
import { addMember, makeStopLink } from "@/server/volunteers/roster";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { meta, NOW } from "./support/meals";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown, jar: {} as Record<string, string>, set: [] as { name: string; value: string; options: Record<string, unknown> }[] }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-vercel-forwarded-for": "203.0.113.77" }),
  cookies: async () => ({
    get: (name: string) => (state.jar[name] ? { value: state.jar[name] } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.set.push({ name, value, options });
      state.jar[name] = value;
    },
  }),
}));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/volunteers" }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { claimAction, claimEveryTimeAction } from "@/app/v/actions";
import NewVolunteerTaskPage from "@/app/volunteers/new/page";
import { startJourney } from "@/server/journeys/journeys";
import { setCorpsNote } from "@/server/care/care-items";
import { joinAction, stopAction } from "@/app/join/actions";
import { JOIN_STAMP_SCOPE } from "@/app/join/scope";
import JoinPage, { metadata as joinMetadata } from "@/app/join/page";
import StopPage from "@/app/join/stop/[token]/page";
import PublicTaskPage from "@/app/v/[token]/page";
import MyClaimPage from "@/app/v/c/[token]/page";
import RosterPage from "@/app/volunteers/roster/page";
import RosterSignPage from "@/app/volunteers/roster/sign/page";
import VolunteersPage from "@/app/volunteers/page";
import { CorpsNote } from "@/components/corps-note";
import { navItems } from "@/components/shell/app-shell";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const p = <T,>(v: T) => Promise.resolve(v);
const notFound = { digest: expect.stringContaining("404") };
const PLACE = "41 Elm Court, St. Louis";
const SECRET = "Lost her husband last week";

const task = (over: Record<string, unknown> = {}) => createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", timeWindow: "2 to 4 pm", place: PLACE, ...over }, NOW);

function formOf(scope: string, over: Record<string, string> = {}) {
  const f = new FormData();
  const fields: Record<string, string> = { stamp: signRenderStamp(scope, NOW), website: "", firstName: "Rina", lastName: "Stein", contact: "rina@example.test", consent: "on", availability: "", ...over };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  f.append("canDo", "visits");
  vi.setSystemTime(new Date(NOW.getTime() + 9_000));
  return f;
}

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-corps-screens";
  process.env.BETTER_AUTH_URL = "https://care.example.test";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  vi.setSystemTime(NOW);
  db = await testDb();
  state.db = db;
  state.jar = {};
  state.set = [];
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("the public join page", () => {
  it("is a plain public page, not indexed, with the consent line and the honeypot, and the same thanks for a new person and a repeat", async () => {
    const out = await html(JoinPage());
    expect(out).toContain("Join Mitzvah Corps");
    expect(out).toContain('name="website"');
    expect(out).toContain("Mitzvah Corps coordinators and clergy will see this and may contact you about ways to help.");
    expect(out).not.toMatch(/<nav|Sign out|<script[^>]+src=/);
    expect(joinMetadata).toMatchObject({ robots: { index: false, follow: false }, referrer: "no-referrer" });
    const first = await joinAction({ status: "idle" }, formOf(JOIN_STAMP_SCOPE));
    const again = await joinAction({ status: "idle" }, formOf(JOIN_STAMP_SCOPE, { firstName: "Rina B" }));
    expect(first).toEqual({ status: "sent" });
    expect(again).toEqual(first);
    expect(await db.select().from(corpsMembers)).toHaveLength(1);
    // A form that was not rendered by us is asked to reload; nothing is made.
    const stale = await joinAction({ status: "idle" }, formOf(JOIN_STAMP_SCOPE, { stamp: "forged", contact: "x@example.test" }));
    expect(stale).toMatchObject({ status: "error", reason: "stale" });
    expect(await db.select().from(corpsMembers)).toHaveLength(1);
  });
});

describe("the stop page", () => {
  it("opening it only shows a button; the POST stops the asks; a wrong link is a missing page", async () => {
    const m = await addMember(db, t.lead, { firstName: "Avi", lastName: "Mor", email: "avi@example.test", canDo: [] }, NOW);
    const { token } = await makeStopLink(db, t.lead, m.id, true);
    const out = await html(StopPage({ params: p({ token }) }));
    expect(out).toContain('data-testid="stop-form"');
    expect(out).toContain("Yes, stop asking me");
    expect((await db.select().from(corpsMembers))[0].status).toBe("active");
    const f = new FormData();
    f.set("token", token);
    f.set("website", "");
    expect(await stopAction({ status: "idle" }, f)).toEqual({ status: "stopped" });
    expect((await db.select().from(corpsMembers).where(eq(corpsMembers.id, m.id)))[0].status).toBe("left");
    const bad = new FormData();
    bad.set("token", "nope");
    expect(await stopAction({ status: "idle" }, bad)).toMatchObject({ status: "error" });
    await expect(html(StopPage({ params: p({ token: "nope" }) }))).rejects.toMatchObject(notFound);
  });
});

describe("the roster screen and the lead's nav", () => {
  it("owner, clergy and the lead see the roster with contacts; staff, caregivers and senior staff are told they have no access", async () => {
    await addMember(db, t.lead, { firstName: "Avi", lastName: "Mor", email: "avi@example.test", mobile: "314-555-0101", canDo: ["visits"], coordinatorNotes: "Prefers texts" }, NOW);
    for (const a of [t.owner, t.clergy, t.lead]) {
      as(a);
      const out = await html(RosterPage({ searchParams: p({}) }));
      expect(out).toContain("Avi Mor");
      expect(out).toContain("avi@example.test");
      expect(out).toContain("Prefers texts");
      expect(out).not.toMatch(/download|.csv|href="[^"]*export/i);
    }
    for (const a of [t.staff, t.carer, t.senior]) {
      as(a);
      const out = await html(RosterPage({ searchParams: p({}) }));
      expect(out).toContain("You do not have access to the roster");
      expect(out).not.toContain("avi@example.test");
      expect(navItems(a).some((i) => i.href === "/volunteers/roster")).toBe(false);
    }
    as(t.lead);
    expect((await html(RosterPage({ searchParams: p({ q: "zzz" }) })))).toContain("Nobody matches that");
    expect(navItems(t.lead).slice(0, 5).map((i) => i.label)).toEqual(["Volunteers", "Mitzvah Meals", "Roster", "Visiting list", "Report a need"]);
    expect(navItems(t.clergy).some((i) => i.href === "/volunteers/roster")).toBe(true);
  });

  it("the printable sign carries the public address and is for roster managers only", async () => {
    as(t.lead);
    expect(await html(RosterSignPage())).toContain("https://care.example.test/join");
    as(t.staff);
    expect(await html(RosterSignPage())).toContain("do not have access");
  });
});

describe("the coordinator home page", () => {
  it("a lead sees the five sections and none of a restricted item's task or care text; clergy see their own", async () => {
    const hidden = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET, restricted: true });
    await createVolunteerTask(db, t.clergy, { kind: "call", forLabel: "Hidden Hannah", needed: "Call Hannah", date: "2026-12-03", careItemId: hidden.id }, NOW);
    await task({ forLabel: "Dan" });
    as(t.lead);
    const out = await html(VolunteersPage());
    for (const section of ["Needs someone", "My steps", "Meals", "Changed since yesterday", "This week"]) expect(out).toContain(section);
    expect(out).toContain('data-testid="home-need"');
    expect(out).toContain("Ask the roster");
    for (const leak of ["Hidden Hannah", SECRET, "Ruth Cohen", hidden.id]) expect(out, leak).not.toContain(leak);
    as(t.clergy);
    expect(await html(VolunteersPage())).toContain("Hidden Hannah");
    as(t.staff);
    expect(await html(VolunteersPage())).toContain("do not have access");
  });
});

describe("the clergy note field", () => {
  it("is drawn for an item that is not restricted, and not at all for a restricted one", async () => {
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement" });
    expect(renderToStaticMarkup(<CorpsNote item={plain} who="Ruth" />)).toContain("Logistics only. Nothing medical or private: the coordinator and volunteers may see this.");
    const restricted = await createCareItem(db, t.clergy, { sfContactId: "003000000000009AAA", displayName: "Dan Levy", category: "illness", restricted: true });
    expect(renderToStaticMarkup(<CorpsNote item={restricted} who="Dan" />)).toBe("");
  });
});

describe("the volunteer's own page: maps, every time, and commitments", () => {
  it("shows Open in Google Maps only after a claim and only while the task is live", async () => {
    const v = await task();
    const pub = await html(PublicTaskPage({ params: p({ token: v.publicToken! }) }));
    expect(pub).not.toContain("maps-link");
    expect(pub).not.toContain("google.com/maps");
    const r = await claimTask(db, v.publicToken!, { firstName: "Sam", lastName: "Katz", contact: "sam@example.test", mayAskAgain: false }, meta(), NOW);
    if (!r.ok) throw new Error("setup");
    const mine = await html(MyClaimPage({ params: p({ token: r.manageToken }), searchParams: p({}) }));
    expect(mine).toContain('data-testid="maps-link"');
    expect(mine).toContain("https://www.google.com/maps/search/?api=1&amp;query=41%20Elm%20Court%2C%20St.%20Louis");
    // Two days after the date the page no longer gives the place, so there is no link.
    vi.setSystemTime(new Date("2026-12-08T18:00:00Z"));
    expect(await html(MyClaimPage({ params: p({ token: r.manageToken }), searchParams: p({}) }))).not.toContain("maps-link");
    vi.setSystemTime(NOW);
  });

  it("offers I can do this every time on a repeating task only, and signs up for every date on one page with a map link for each", async () => {
    const lone = await task({ date: "2026-12-10" });
    expect(await html(PublicTaskPage({ params: p({ token: lone.publicToken! }) }))).not.toContain('data-testid="every-time"');
    const s = await createVolunteerSeries(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-02", place: PLACE, every: 1, weekdays: [3], count: 3 }, NOW);
    expect(await html(PublicTaskPage({ params: p({ token: s.first.publicToken! }) }))).toContain('data-testid="every-time"');
    const f = formOf(s.first.publicToken!, { token: s.first.publicToken!, contact: "sam@example.test" });
    let target = "";
    try {
      await claimEveryTimeAction({ status: "idle" }, f);
    } catch (e) {
      target = String((e as { digest?: string }).digest);
    }
    const token = target.split("/v/c/")[1]?.split("?")[0] ?? "";
    expect(token.length).toBeGreaterThan(10);
    const out = await html(MyClaimPage({ params: p({ token }), searchParams: p({ new: "1" }) }));
    expect(out.match(/data-testid="my-date"/g)).toHaveLength(3);
    expect(out.match(/data-testid="maps-link"/g)).toHaveLength(3);
    expect(out).toContain("Give back all the dates ahead");
  });
});

describe("the volunteer's cookie and the other dates", () => {
  const claimForm = (token: string, over: Record<string, string> = {}) => formOf(token, { token, contact: "sam@example.test", ...over });
  const redirected = async (f: FormData) => {
    try {
      await claimAction({ status: "idle" }, f);
    } catch (e) {
      return String((e as { digest?: string }).digest);
    }
    return "";
  };

  it("claiming sets one opaque first-party cookie (HttpOnly, SameSite=Lax, path /v, 180 days) and reuses it; the personal page then lists their other dates and no one else's", async () => {
    const a = await task({ date: "2026-12-05", forLabel: "Ruth" });
    const b = await task({ date: "2026-12-06", forLabel: "Dan" });
    const c = await task({ date: "2026-12-07", forLabel: "Stranger's" });
    await redirected(claimForm(a.publicToken!));
    expect(state.set).toHaveLength(1);
    expect(state.set[0]).toMatchObject({ name: "crc_vol_ref", options: { httpOnly: true, sameSite: "lax", path: "/v", maxAge: 180 * 86_400 } });
    expect(state.set[0].value).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(state.set)).not.toMatch(/sam@|example.test|Katz/);
    const ref = state.set[0].value;
    const second = await redirected(claimForm(b.publicToken!));
    expect(state.set[1].value).toBe(ref);
    // Someone else, on their own device, who types Sam's email.
    state.jar = {};
    const third = await redirected(claimForm(c.publicToken!, { contact: "sam@example.test", firstName: "Eve" }));
    const tokenOf = (target: string) => target.split("/v/c/")[1].split("?")[0];
    const sam = await html(MyClaimPage({ params: p({ token: tokenOf(second) }), searchParams: p({}) }));
    expect(sam).toContain("Your other dates");
    expect(sam).toContain("Visit for Ruth");
    expect(sam).not.toContain("Stranger");
    const eve = await html(MyClaimPage({ params: p({ token: tokenOf(third) }), searchParams: p({}) }));
    expect(eve).not.toContain("Your other dates");
    expect(eve).not.toContain("Visit for Ruth");
  });

  it("a place typed on several lines still gets a Maps link, joined with commas", async () => {
    const v = await task({ place: "41 Elm Court\nSt. Louis, MO" });
    const r = await claimTask(db, v.publicToken!, { firstName: "Sam", lastName: "Katz", contact: "sam@example.test", mayAskAgain: false }, meta(), NOW);
    if (!r.ok) throw new Error("setup");
    const out = await html(MyClaimPage({ params: p({ token: r.manageToken }), searchParams: p({}) }));
    expect(out).toContain("query=41%20Elm%20Court%2C%20St.%20Louis%2C%20MO");
  });
});

describe("posting from a step that carries the clergy's note", () => {
  it("starts the text from the note and says so above the field", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement" });
    await setCorpsNote(db, t.clergy, item.id, "Meals on Tuesday and Thursday.");
    await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: "2026-11-24" }, NOW);
    as(t.lead);
    const { listLeadSteps } = await import("@/server/care/follow-ups");
    const [step] = await listLeadSteps(db, t.lead, NOW);
    const out = await html(NewVolunteerTaskPage({ searchParams: p({ step: step.id }) }));
    expect(out).toContain("Meals on Tuesday and Thursday.");
    expect(out).toContain("Started from the clergy&#x27;s note for Mitzvah Corps. Volunteers will see whatever is in this box.".replace("&#x27;", "&rsquo;").replace("&rsquo;", "’"));
  });
});
