import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem, updateCareItem } from "@/server/care/care-items";
import { followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { signRenderStamp } from "@/server/meals/client-meta";
import { cancelVolunteerTask, createVolunteerSheet, createVolunteerTask, getBoardLink } from "@/server/volunteers/organiser";
import { addBringing, claimTask } from "@/server/volunteers/public";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { meta, NOW } from "./support/meals";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-vercel-forwarded-for": "203.0.113.50" }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/volunteers" }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { bringingAction, cancelClaimAction, claimAction, doneClaimAction, type ClaimState } from "@/app/v/actions";
import PublicTaskPage, { metadata as taskMetadata } from "@/app/v/[token]/page";
import PublicBoardPage from "@/app/v/b/[token]/page";
import PublicSheetPage from "@/app/v/s/[token]/page";
import MyClaimPage from "@/app/v/c/[token]/page";
import { GET as calendarFile } from "@/app/v/c/[token]/calendar.ics/route";
import VolunteersNotFound from "@/app/v/not-found";
import VolunteersPage from "@/app/volunteers/page";
import VolunteerTaskPage from "@/app/volunteers/[id]/page";
import ShivaSheetPage from "@/app/volunteers/sheets/[id]/page";
import VolunteerTaskFlyerPage from "@/app/volunteers/[id]/flyer/page";
import ShivaSheetFlyerPage from "@/app/volunteers/sheets/[id]/flyer/page";
import VolunteerBoardFlyerPage from "@/app/volunteers/board/flyer/page";
import NewVolunteerTaskPage from "@/app/volunteers/new/page";
import { navItems } from "@/components/shell/app-shell";
import { LeadSteps } from "@/components/lead-steps";
import { loadVolunteerTasks, PersonVolunteers } from "@/components/volunteers/person-volunteers";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const p = <T,>(v: T) => Promise.resolve(v);
const PLACE = "41 Elm Court, St. Louis";
const CONTACT_LINE = "Ask Dana, 314-555-0100";
const notFound = { digest: expect.stringContaining("404") };
const redirects = (to: string) => ({ digest: expect.stringContaining(to) });

const task = (over: Record<string, unknown> = {}) => createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", timeWindow: "2 to 4 pm", place: PLACE, contactLine: CONTACT_LINE, ...over }, NOW);
const vol = (over: Record<string, unknown> = {}) => ({ firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "", mayAskAgain: false, ...over });
const taskPage = (token: string) => html(PublicTaskPage({ params: p({ token }) }));
const claimed = async (token: string, over: Record<string, unknown> = {}) => {
  const r = await claimTask(db, token, vol(over), meta(), NOW);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

/** A claim form as the browser sends it: the stamp the page gave, filled in after a person could have filled it. */
function form(token: string, over: Record<string, string> = {}, opts: { fresh?: boolean } = {}) {
  const f = new FormData();
  const fields: Record<string, string> = { token, stamp: signRenderStamp(token, NOW), website: "", firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "", ...over };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  vi.setSystemTime(new Date(NOW.getTime() + (opts.fresh ? 0 : 9_000)));
  return f;
}

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-volunteer-screens";
  process.env.BETTER_AUTH_URL = "https://care.example.test";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

beforeEach(async () => {
  vi.setSystemTime(NOW);
  db = await testDb();
  state.db = db;
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("the public task page", () => {
  it("shows what is needed and when, never where, the contact line or anyone's name, in its HTML or its metadata", async () => {
    const v = await task();
    await claimed(v.publicToken!);
    const out = await taskPage(v.publicToken!);
    expect(out).toContain("Visit for Ruth");
    expect(out).toContain("Central Reform Congregation");
    expect(out).toContain("Sit with Ruth for an hour");
    expect(out).toContain("2 to 4 pm");
    for (const leak of [PLACE, "Elm", CONTACT_LINE, "314", "Sam", "Katz", "example.test", v.id, t.lead.id, t.lead.email]) expect(out, leak).not.toContain(leak);
    // The page and its link preview are the same line whatever the task.
    expect(words(taskMetadata)).not.toMatch(/Ruth|Elm|Visit/);
    expect(taskMetadata).toMatchObject({ title: "Can you help? · Central Reform Congregation", robots: { index: false, follow: false }, referrer: "no-referrer", openGraph: { title: "Can you help? · Central Reform Congregation" } });
    // No app shell, no navigation, no third-party script.
    expect(out).not.toMatch(/<nav|Volunteers<|Sign out|<script[^>]+src=/);
  });

  it("offers the form with the open places while there are any, a kind thank-you when full, and a kind note once the date has passed", async () => {
    const v = await task({ peopleNeeded: 2 });
    let out = await taskPage(v.publicToken!);
    expect(out).toContain('data-testid="claim-form"');
    expect(out).toContain("2 places left");
    expect(out).toContain('name="website"');
    expect(out).toMatch(/name="stamp" value="\d+\.[\w-]+"/);
    await claimed(v.publicToken!, { contact: "a@example.test" });
    await claimed(v.publicToken!, { contact: "b@example.test" });
    out = await taskPage(v.publicToken!);
    expect(out).toContain('data-testid="full"');
    expect(out).not.toContain('data-testid="claim-form"');
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 86_400_000));
    out = await taskPage(v.publicToken!);
    expect(out).toContain('data-testid="past"');
  });

  it("an unknown, cancelled and expired link are all the same 404 and the not-found page says one kind thing", async () => {
    const v = await task();
    await cancelVolunteerTask(db, t.lead, v.id, NOW);
    await expect(taskPage("nope")).rejects.toMatchObject(notFound);
    await expect(taskPage(v.publicToken!)).rejects.toMatchObject(notFound);
    const w = await task();
    vi.setSystemTime(new Date(NOW.getTime() + 7 * 86_400_000));
    await expect(taskPage(w.publicToken!)).rejects.toMatchObject(notFound);
    const out = await html(VolunteersNotFound());
    expect(out).toContain("no longer open");
    expect(out).not.toContain("Elm");
  });
});

describe("the claim action", () => {
  it("sends a successful claim to the volunteer's own page; a stale stamp, a honeypot and a bad form are refused and keep nothing", async () => {
    const v = await task();
    const token = v.publicToken!;
    const idle: ClaimState = { status: "idle" };
    await expect(claimAction(idle, form(token))).rejects.toMatchObject(redirects("/v/c/"));
    expect(await claimAction(idle, form(token, { stamp: "1.2" }))).toMatchObject({ status: "error", reason: "stale" });
    expect(await claimAction(idle, form(token, { website: "http://spam", contact: "other@example.test" }))).toMatchObject({ status: "error", reason: "refused" });
    expect(await claimAction(idle, form(token, { contact: "nonsense", firstName: "Zed" }))).toMatchObject({ status: "error", reason: "invalid", fields: ["contact"] });
    // Filled in too fast to be a person.
    expect(await claimAction(idle, form(token, { contact: "fast@example.test" }, { fresh: true }))).toMatchObject({ status: "error", reason: "refused" });
    // Only the first claim made it.
    expect(await taskPage(token)).toContain('data-testid="full"');
  });

  it("the volunteer's page gives the place, the time, the contact line and a calendar file; cancel and done change it; the file is no-store and noindex", async () => {
    const v = await task();
    const r = await claimed(v.publicToken!);
    let out = await html(MyClaimPage({ params: p({ token: r.manageToken }), searchParams: p({ new: "1" }) }));
    expect(out).toContain("Thank you for helping");
    expect(out).toContain(PLACE);
    expect(out).toContain("2 to 4 pm");
    expect(out).toContain(CONTACT_LINE);
    expect(out).toContain(`/v/c/${r.manageToken}/calendar.ics`);
    expect(out).toContain("Give my place back");
    expect(out).toContain("Mark it done");

    const res = await calendarFile(new Request("https://x"), { params: p({ token: r.manageToken }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("LOCATION:41 Elm Court");

    expect(await cancelClaimAction({ status: "idle" }, form(r.manageToken, {}))).toMatchObject({ status: "ok" });
    out = await html(MyClaimPage({ params: p({ token: r.manageToken }), searchParams: p({}) }));
    expect(out).toContain('data-testid="state-cancelled"');
    expect(out).not.toContain(PLACE);
    expect((await calendarFile(new Request("https://x"), { params: p({ token: r.manageToken }) })).status).toBe(404);
    await expect(html(MyClaimPage({ params: p({ token: "nope" }), searchParams: p({}) }))).rejects.toMatchObject(notFound);

    const w = await task();
    const s = await claimed(w.publicToken!);
    expect(await doneClaimAction({ status: "idle" }, form(s.manageToken, { note: "It went well" }))).toMatchObject({ status: "ok" });
    out = await html(MyClaimPage({ params: p({ token: s.manageToken }), searchParams: p({}) }));
    expect(out).toContain('data-testid="state-done"');
  });
});

describe("the board page", () => {
  it("lists the open tasks with the places left and links, and says so kindly when there are none", async () => {
    const v = await task({ forLabel: "Moe", kind: "ride" });
    const board = await getBoardLink(db, t.lead);
    const out = await html(PublicBoardPage({ params: p({ token: board.token }) }));
    expect(out).toContain("Ways to help");
    expect(out).toContain("Ride for Moe");
    expect(out).toContain("1 place left");
    expect(out).toContain(`href="/v/${v.publicToken}"`);
    for (const leak of [PLACE, CONTACT_LINE, "Sit with Ruth"]) expect(out, leak).not.toContain(leak);
    await claimed(v.publicToken!);
    expect(await html(PublicBoardPage({ params: p({ token: board.token }) }))).toContain('data-testid="board-empty"');
    await expect(html(PublicBoardPage({ params: p({ token: "nope" }) }))).rejects.toMatchObject(notFound);
  });
});

describe("the shiva sheet page", () => {
  it("shows each evening's count toward ten, first names on the bringing list, and never the place; a claim reaches the volunteer's page with the place", async () => {
    const sheet = await createVolunteerSheet(db, t.lead, { title: "the Cohen family", place: PLACE, evenings: [{ date: "2026-12-03", timeWindow: "7 pm" }, { date: "2026-12-04" }] }, NOW);
    const token = sheet.publicToken!;
    await addBringing(db, token, { firstName: "Ann", line: "Kugel for Thursday" }, meta(), NOW);
    const evening = sheet.evenings[0];
    let out = await html(PublicSheetPage({ params: p({ token }), searchParams: p({}) }));
    expect(out).toContain("Shiva for the Cohen family");
    expect(out.match(/data-testid="evening-open"/g)).toHaveLength(2);
    expect(out).toContain("0 of 10");
    expect(out).toContain("Ann");
    expect(out).toContain("Kugel for Thursday");
    expect(out).not.toContain(PLACE);
    out = await html(PublicSheetPage({ params: p({ token }), searchParams: p({ evening: evening.id }) }));
    expect(out).toContain('data-testid="claim-form"');
    expect(out).toContain(`name="taskId" value="${evening.id}"`);

    const f = form(token, { contact: "p2@example.test" });
    f.set("taskId", evening.id);
    await expect(claimAction({ status: "idle" }, f)).rejects.toMatchObject(redirects("/v/c/"));
    out = await html(PublicSheetPage({ params: p({ token }), searchParams: p({}) }));
    expect(out).toMatch(/2 of 10|1 of 10/);
    expect(out).not.toContain(PLACE);
    expect(out).not.toContain("p2@example.test");

    const b = form(token, { firstName: "Ben", line: "Plates" });
    expect(await bringingAction({ status: "idle" }, b)).toMatchObject({ status: "ok" });
    await expect(html(PublicSheetPage({ params: p({ token: "nope" }), searchParams: p({}) }))).rejects.toMatchObject(notFound);
  });
});

describe("the poster's pages", () => {
  it("Volunteers is in the nav for owner, clergy and lead only", () => {
    const has = (a: Actor) => navItems(a).some((i) => i.href === "/volunteers");
    expect([t.owner, t.clergy, t.lead].map(has)).toEqual([true, true, true]);
    expect([t.staff, t.carer, t.senior].map(has)).toEqual([false, false, false]);
  });

  it("the list shows tasks that need people first, the board block, and the ask-again list; others get a plain notice", async () => {
    const v = await task({ forLabel: "Ruth" });
    await task({ forLabel: "Dov", kind: "call" });
    await claimed(v.publicToken!, { mayAskAgain: true, contact: "again@example.test" });
    as(t.lead);
    const out = await html(VolunteersPage());
    expect(out).toContain("Needs people");
    expect(out.indexOf("Call for Dov")).toBeLessThan(out.indexOf("Visit for Ruth"));
    expect(out).toContain("Past helpers who said ask me again");
    expect(out).toContain("again@example.test");
    expect(out).toContain("Make my board link");
    for (const a of [t.staff, t.carer, t.senior]) {
      as(a);
      const denied = await html(VolunteersPage());
      expect(denied).toContain("do not have access");
      expect(denied).not.toContain("Visit for Ruth");
    }
  });

  it("a task page shows who signed up with their contact; a restricted item's task is a 404 to a lead and to the owner", async () => {
    const v = await task();
    await claimed(v.publicToken!, { note: "Happy to help" });
    as(t.clergy);
    const out = await html(VolunteerTaskPage({ params: p({ id: v.id }) }));
    expect(out).toContain("Sam Katz");
    expect(out).toContain("sam@example.test");
    expect(out).toContain("Happy to help");
    expect(out).toContain(v.publicToken!);
    expect(out).toContain("Copy the link");
    expect(out).toContain("sms:?&amp;body=");
    expect(out).toContain("mailto:?subject=");

    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "x", restricted: true });
    const secret = await createVolunteerTask(db, t.clergy, { kind: "visit", forLabel: "Hidden", needed: "x", date: "2026-12-05", careItemId: item.id }, NOW);
    for (const actor of [t.lead, t.owner]) {
      as(actor);
      await expect(html(VolunteerTaskPage({ params: p({ id: secret.id }) }))).rejects.toMatchObject(notFound);
      expect(await html(VolunteersPage())).not.toContain("Hidden");
    }
    as(t.clergy);
    expect(await html(VolunteerTaskPage({ params: p({ id: secret.id }) }))).toContain("Hidden");
  });

  it("a shiva sheet page lets the poster remove a bringing line and shows each evening's claims", async () => {
    const sheet = await createVolunteerSheet(db, t.lead, { title: "the Cohen family", evenings: [{ date: "2026-12-03" }] }, NOW);
    await addBringing(db, sheet.publicToken, { firstName: "Ann", line: "Kugel" }, meta(), NOW);
    as(t.lead);
    const out = await html(ShivaSheetPage({ params: p({ id: sheet.id }) }));
    expect(out).toContain("Shiva for the Cohen family");
    expect(out).toContain("Kugel");
    expect(out).toContain("Remove Ann");
    expect(out).toContain(sheet.publicToken!);
  });

  it("the new-task form is filled from a lead's step (first name and title only) and from a care item for clergy, never for a lead", async () => {
    as(t.lead);
    let out = await html(NewVolunteerTaskPage({ searchParams: p({}) }));
    expect(out).toContain("Post the task");
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "x" });
    out = await html(NewVolunteerTaskPage({ searchParams: p({ careItem: item.id }) }));
    expect(out).toContain("could not be found");
    expect(out).not.toContain("Ruth Cohen");
    expect(out).not.toContain('name="careItemId"');
    as(t.clergy);
    out = await html(NewVolunteerTaskPage({ searchParams: p({ careItem: item.id }) }));
    expect(out).toContain('name="careItemId"');
    expect(out).toContain('value="Ruth"');
  });

  it("Post this to volunteers from a lead's step fills in the kind and date only: never the label or the words volunteers read", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "x" });
    const [step] = await db
      .insert(followUps)
      .values({ careItemId: item.id, sfContactId: CONTACT, displayName: "Ruth Cohen", title: "Arrange the shiva minyan", dueDate: "2026-12-04", ownerUserId: t.lead.id, createdBy: t.clergy.id, forLead: true })
      .returning({ id: followUps.id });
    as(t.lead);
    const out = await html(NewVolunteerTaskPage({ searchParams: p({ step: step.id }) }));
    expect(out).toContain('value="shiva_minyan" selected');
    expect(out).toContain('value="2026-12-04"');
    for (const leak of ["Arrange the shiva minyan", "Ruth Cohen", "Ruth", item.id]) expect(out.replace(/like &quot;Ruth&quot;|&ldquo;Ruth&rdquo;|“Ruth”/g, ""), leak).not.toContain(leak);
    expect(out).not.toMatch(/name="forLabel"[^>]*value="[^"]+"/);
    expect(out).not.toMatch(/<textarea[^>]*name="needed"[^>]*>[^<]+</);
  });

  it("the volunteer's page says the task has passed once it is over, and shows neither place nor contact line", async () => {
    const v = await task();
    const r = await claimed(v.publicToken!);
    vi.setSystemTime(new Date(NOW.getTime() + 6 * 86_400_000));
    const out = await html(MyClaimPage({ params: p({ token: r.manageToken }), searchParams: p({}) }));
    expect(out).toContain('data-testid="state-passed"');
    expect(out).not.toContain(PLACE);
    expect(out).not.toContain(CONTACT_LINE);
    expect((await calendarFile(new Request("https://x"), { params: p({ token: r.manageToken }) })).status).toBe(404);
  });

  it("a care item that became restricted tells its full-access viewers the links are still open, with a one-tap close; a lead sees none of it", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "x" });
    await createVolunteerTask(db, t.clergy, { kind: "ride", forLabel: "Ruth", needed: "A ride", date: "2026-12-05", careItemId: item.id }, NOW);
    let tasks = await loadVolunteerTasks(t.clergy, [item.id]);
    expect(renderToStaticMarkup(await Promise.resolve(PersonVolunteers({ tasks, careItemId: item.id, restrictedItemIds: [] })))).not.toContain("restricted-links-open");
    await updateCareItem(db, t.clergy, item.id, { restricted: true });
    tasks = await loadVolunteerTasks(t.clergy, [item.id]);
    const out = renderToStaticMarkup(await Promise.resolve(PersonVolunteers({ tasks, careItemId: item.id, restrictedItemIds: [item.id] })));
    expect(out).toContain('data-testid="restricted-links-open"');
    expect(out).toContain("Close these links");
    expect(await loadVolunteerTasks(t.lead, [item.id])).toBeNull();
  });

  it("a lead's step offers 'Post this to volunteers'", () => {
    const out = renderToStaticMarkup(<LeadSteps today="2026-12-01" steps={[{ id: "s1", person: "Ruth Cohen", title: "Arrange the shiva minyan", dueDate: "2026-12-03", done: false, outcomeNote: null, mealsHref: null, corpsNote: null }]} />);
    expect(out).toContain("Post this to volunteers");
    expect(out).toContain('href="/volunteers/new?step=s1"');
  });

  it("a care item shows its volunteer tasks to the clergy who fully see it, and nothing to a lead", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "x" });
    await createVolunteerTask(db, t.clergy, { kind: "ride", forLabel: "Ruth", needed: "A ride to the clinic", date: "2026-12-05", careItemId: item.id }, NOW);
    const tasks = await loadVolunteerTasks(t.clergy2, [item.id]);
    const out = renderToStaticMarkup(await Promise.resolve(PersonVolunteers({ tasks, careItemId: item.id })));
    expect(out).toContain("Volunteer tasks");
    expect(out).toContain("Ride for Ruth");
    expect(out).toContain(`/volunteers/new?careItem=${item.id}`);
    expect(await loadVolunteerTasks(t.lead, [item.id])).toBeNull();
    expect(await loadVolunteerTasks(t.carer, [item.id])).toBeNull();
  });
});

describe("flyers", () => {
  it("prints a task flyer with the QR and link, and never the place or contact line", async () => {
    const v = await task();
    as(t.lead);
    const out = await html(VolunteerTaskFlyerPage({ params: p({ id: v.id }) }));
    expect(out).toContain("<svg");
    expect(out).toContain(`https://care.example.test/v/${v.publicToken}`);
    expect(out).toContain("Sit with Ruth for an hour");
    expect(out).not.toContain("Elm Court");
    expect(out).not.toContain("314-555-0100");
    expect(await html(VolunteerTaskPage({ params: p({ id: v.id }) }))).toContain(`/volunteers/${v.id}/flyer`);
  });

  it("offers no link once the task is cancelled or its date has passed, and hides it from outsiders", async () => {
    const v = await task();
    const old = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-11-20", place: PLACE }, new Date("2026-11-18T18:00:00Z"));
    as(t.lead);
    const past = await html(VolunteerTaskFlyerPage({ params: p({ id: old.id }) }));
    expect(past).not.toContain("<svg");
    expect(past).toContain("no longer open");
    await cancelVolunteerTask(db, t.lead, v.id, NOW);
    expect(await html(VolunteerTaskFlyerPage({ params: p({ id: v.id }) }))).not.toContain("<svg");
    const mine = await task();
    as(t.carer);
    expect(await html(VolunteerTaskFlyerPage({ params: p({ id: mine.id }) }))).toContain("do not have access");
  });

  it("prints a shiva sheet flyer and a board flyer", async () => {
    const sheet = await createVolunteerSheet(db, t.lead, { title: "the Cohen family", place: PLACE, evenings: [{ date: "2026-12-03", timeWindow: "7 pm" }] }, NOW);
    as(t.lead);
    const out = await html(ShivaSheetFlyerPage({ params: p({ id: sheet.id }) }));
    expect(out).toContain("<svg");
    expect(out).toContain(`/v/s/${sheet.publicToken}`);
    expect(out).not.toContain("Elm Court");
    expect(await html(ShivaSheetPage({ params: p({ id: sheet.id }) }))).toContain(`/volunteers/sheets/${sheet.id}/flyer`);
    const none = await html(VolunteerBoardFlyerPage());
    expect(none).not.toContain("<svg");
    const board = await getBoardLink(db, t.lead);
    const withBoard = await html(VolunteerBoardFlyerPage());
    expect(withBoard).toContain("<svg");
    expect(withBoard).toContain(`/v/b/${board.token}`);
  });
});
