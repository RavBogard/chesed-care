import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { eq } from "drizzle-orm";
import { volunteerClaims } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { signRenderStamp } from "@/server/meals/client-meta";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { cancelMyClaim, claimTask, markMyClaimDone } from "@/server/volunteers/public";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { createCareItem } from "@/server/care/care-items";
import { meta, NOW } from "./support/meals";
import { words } from "./support/words";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-vercel-forwarded-for": "203.0.113.50" }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/volunteers", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { flagAction } from "@/app/v/actions";
import MyClaimPage from "@/app/v/c/[token]/page";
import InboxPage from "@/app/inbox/page";
import VolunteersPage from "@/app/volunteers/page";
import VolunteerTaskPage from "@/app/volunteers/[id]/page";
import { FLAG_WORDS } from "@/lib/volunteers-wording";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const p = <T,>(v: T) => Promise.resolve(v);
const WORDS = "I think I am in over my head with this one.";

async function claimed(actor: Actor = t.lead) {
  const task = await createVolunteerTask(db, actor, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", timeWindow: "2 to 4 pm", place: "41 Elm Court" }, NOW);
  const r = await claimTask(db, task.publicToken, { firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "", mayAskAgain: false }, meta(), NOW);
  if (!r.ok) throw new Error(r.reason);
  // The database stamps createdAt with the real clock; the pages here run on the test's NOW.
  await db.update(volunteerClaims).set({ createdAt: NOW }).where(eq(volunteerClaims.id, r.claimId));
  return { task, token: r.manageToken };
}
const myPage = (token: string) => html(MyClaimPage({ params: p({ token }), searchParams: p({}) }));

/** The flag form as the browser sends it: the page's stamp, sent a while after the page was drawn. */
function flagForm(token: string, text: string, opts: { stamp?: string; website?: string } = {}) {
  const f = new FormData();
  f.set("token", token);
  f.set("stamp", opts.stamp ?? signRenderStamp(token, NOW));
  f.set("website", opts.website ?? "");
  f.set("words", text);
  vi.setSystemTime(new Date(NOW.getTime() + 9_000));
  return f;
}

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-volunteer-flag";
  process.env.BETTER_AUTH_URL = "https://care.example.test";
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterAll(() => vi.useRealTimers());

beforeEach(async () => {
  vi.setSystemTime(NOW);
  db = await testDb();
  state.db = db;
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("the volunteer's own page", () => {
  it("has the control beside Done, with the guidance line, a box and a Send button, all inside the timed form", async () => {
    const { token } = await claimed();
    const out = await myPage(token);
    expect(out).toContain("When it is done");
    expect(out).toContain(FLAG_WORDS.open);
    expect(out).toContain("You are not expected to handle an emergency. In an emergency, call 911. Otherwise, write it here and the rabbis will see it.");
    // Plain, calm words: no exclamation marks anywhere in what the volunteer reads.
    for (const line of Object.values(FLAG_WORDS)) expect(line).not.toContain("!");
    expect(out).toMatch(/<textarea[^>]*name="words"[^>]*maxLength="1000"/);
    expect(out).toContain(">Send<");
    expect(out).toContain('name="stamp"');
    expect(out).toContain('name="website"');
    // The open control is a 44px target, like every other button.
    expect(out).toMatch(/<summary class="[^"]*min-h-11/);
    expect(out.indexOf("Mark it done")).toBeLessThan(out.indexOf(FLAG_WORDS.open));
  });

  it("is still there once the volunteer has said it is done, and gone once the place is given back", async () => {
    const a = await claimed();
    await markMyClaimDone(db, a.token, "", meta(), NOW);
    expect(await myPage(a.token)).toContain(FLAG_WORDS.open);
    const b = await claimed();
    await cancelMyClaim(db, b.token, meta(), NOW);
    expect(await myPage(b.token)).not.toContain(FLAG_WORDS.open);
  });

  it("sending answers only that it was sent; a refusal gets the page's calm wording", async () => {
    const { token } = await claimed();
    expect(await flagAction({ status: "idle" }, flagForm(token, WORDS))).toEqual({ status: "sent" });
    expect(FLAG_WORDS.sent).toBe("Sent. A rabbi will see it.");
    expect(await flagAction({ status: "idle" }, flagForm(token, "   "))).toEqual({ status: "error", message: "Please check what you wrote." });
    expect(await flagAction({ status: "idle" }, flagForm(token, WORDS, { stamp: "forged.stamp" }))).toEqual({ status: "error", message: "This form has been open for a long time. Please reload the page and try again." });
    expect(await flagAction({ status: "idle" }, flagForm(token, WORDS, { website: "spam" }))).toEqual({ status: "error", message: "Sorry, we could not complete that. If you think this is a mistake, please ask whoever sent you the link." });
    expect(await flagAction({ status: "idle" }, flagForm("not-a-link", WORDS, { stamp: signRenderStamp("not-a-link", NOW) }))).toEqual({ status: "error", message: "This link is no longer open. Thank you for wanting to help." });
    // Two more today, then the calm "a lot of tries" sentence.
    await flagAction({ status: "idle" }, flagForm(token, `${WORDS} 2`));
    await flagAction({ status: "idle" }, flagForm(token, `${WORDS} 3`));
    expect(await flagAction({ status: "idle" }, flagForm(token, WORDS))).toEqual({ status: "error", message: "We could not take this just now. Please try again later, or call the office. In an emergency, call 911." });
  });
});

describe("the clergy Inbox", () => {
  it("shows the arrival as from a volunteer, with the context and the words", async () => {
    const { token } = await claimed();
    await flagAction({ status: "idle" }, flagForm(token, WORDS));
    as(t.clergy);
    const out = await html(InboxPage({ searchParams: p({}) }));
    expect(out).toContain("A volunteer · Public form");
    expect(out).toContain('<span class="text-alert">Unverified: </span>');
    expect(out).toContain("Volunteer: Sam");
    expect(out).toContain("Task: Visit for Ruth");
    expect(out).toContain(WORDS);
  });
});

describe("a flag on a task for a RESTRICTED care item, in the Inbox", () => {
  it("offers its owner only Add to that item and Dismiss; other clergy and the owner role see no card at all", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "Private", restricted: true });
    const task = await createVolunteerTask(db, t.clergy, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-05", careItemId: item.id }, NOW);
    const r = await claimTask(db, task.publicToken, { firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "", mayAskAgain: false }, meta(), NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(await flagAction({ status: "idle" }, flagForm(r.manageToken, WORDS))).toEqual({ status: "sent" });
    as(t.clergy);
    const out = await html(InboxPage({ searchParams: p({}) }));
    expect(out).toContain('data-testid="inbox-scoped"');
    expect(out).toContain("Add to the illness care for Ruth Cohen");
    expect(out).toContain(">Dismiss<");
    expect(out).not.toContain(">Edit<");
    expect(out).not.toContain(">Accept<");
    for (const other of [t.owner, t.clergy2]) {
      as(other);
      const theirs = await html(InboxPage({ searchParams: p({}) }));
      expect(theirs).not.toContain("inbox-card");
      expect(theirs).not.toContain("over my head");
    }
  });
});

describe("the poster and the coordinator", () => {
  it("see the marker on the task and in the home feed, never the words", async () => {
    const { task, token } = await claimed(t.clergy);
    const before = await (as(t.clergy), html(VolunteerTaskPage({ params: p({ id: task.id }) })));
    expect(before).not.toContain(FLAG_WORDS.marker);
    await flagAction({ status: "idle" }, flagForm(token, WORDS));
    for (const actor of [t.clergy, t.lead]) {
      as(actor);
      const page = await html(VolunteerTaskPage({ params: p({ id: task.id }) }));
      expect(page).toContain(FLAG_WORDS.marker);
      expect(page).toContain('data-testid="flag-marker"');
      expect(words(page)).not.toContain("over my head");
    }
    as(t.lead);
    const home = await html(VolunteersPage());
    expect(home).toContain("A volunteer flagged something for the rabbis: Ruth");
    expect(words(home)).not.toContain("over my head");
  });
});
