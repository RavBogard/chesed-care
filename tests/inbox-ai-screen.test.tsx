import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { acceptProposal, createProposal } from "@/server/care/proposals";
import { createCareItem } from "@/server/care/care-items";
import { createOutsidePerson } from "@/server/care/outside-people";
import { contactLog, followUps, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import type { SfRow } from "@/server/salesforce/client";
import { CONTACT, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown, queries: 0, inflight: 0, maxInflight: 0 }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/server/salesforce", () => ({
  getSalesforce: () => ({
    query: async (): Promise<SfRow[]> => {
      state.queries++;
      state.inflight++;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      await new Promise((r) => setTimeout(r, 5));
      state.inflight--;
      return [];
    },
  }),
}));

import InboxPage, { metadata } from "@/app/inbox/page";
import { DecisionForm } from "@/components/decision-form";
import { initialFor, type InboxEntry } from "@/components/inbox-card";
import { createMatcher } from "@/server/care/reading-match";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const count = (s: string, needle: string) => s.split(needle).length - 1;

beforeAll(async () => {
  db = await testDb();
  state.db = db;
  t = await team(db);
});

const proposal = (reading: Record<string, unknown>) => ({ id: "00000000-0000-4000-8000-000000000001", reading }) as unknown as InboxEntry["proposal"];
const entry = (reading: Record<string, unknown>, existing: { id: string; category: string }[]): InboxEntry => ({
  proposal: proposal(reading),
  person: { kind: "sf", contactId: CONTACT, name: "Ruth Cohen", household: null },
  candidates: [],
  existing,
  nameMatches: [],
  matchPending: false,
  canReread: false,
  suggestedOwnerName: null,
  own: false,
  intake: null,
});
const OPEN = [{ id: "11111111-1111-4111-8111-111111111111", category: "illness" }];

describe("a reading that looks sensitive", () => {
  it("starts as a new restricted item, never as a note on the person's open item", () => {
    const sensitive = initialFor(entry({ by: "app_ai", category: "mental_health", summary: "s", restrictedSuggested: true }, OPEN));
    expect(sensitive.existingCareItemId).toBeUndefined();
    expect(sensitive.restricted).toBe(true);
    // Even a connector reading that points at the item does not pre-select it when it looks sensitive.
    expect(initialFor(entry({ restrictedSuggested: true, existingCareItemId: OPEN[0].id, summary: "s" }, OPEN)).existingCareItemId).toBeUndefined();
    // A plain AI reading with one open item still offers it.
    expect(initialFor(entry({ by: "app_ai", category: "illness", summary: "s", restrictedSuggested: false }, OPEN)).existingCareItemId).toBe(OPEN[0].id);
  });

  it("the sheet shows the restricted control ticked, and warns beside the add-to-existing choice", () => {
    const initial = initialFor(entry({ by: "app_ai", category: "mental_health", summary: "s", restrictedSuggested: true }, OPEN));
    const out = renderToStaticMarkup(<DecisionForm proposalId="p" words="w" today="2026-12-01" actorId={t.clergy.id} holders={[{ id: t.clergy.id, name: "C" }]} initial={initial} />);
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*name="restricted"[^>]*checked=""|<input[^>]*name="restricted"[^>]*checked=""/);
    expect(out).toContain('data-testid="decision-sensitive-hint"');
  });

  it("a note added to an existing item from a sensitive reading is private", async () => {
    const item = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    const p = await createProposal(db, t.clergy, { rawText: "words", channel: "connector", reading: { summary: "s", restrictedSuggested: true }, reviewScope: "clergy" });
    const deps = { db, sf: () => ({ query: async () => [] }), now: new Date("2026-12-01T18:00:00Z") };
    await acceptProposal(deps, t.clergy, p.id, { target: { kind: "existing", careItemId: item.id }, summary: "A sensitive note" });
    const notes = await db.select().from(contactLog);
    expect(notes.filter((n) => n.note === "A sensitive note").map((n) => n.private)).toEqual([true]);
  });
});

describe("the follow-up idea", () => {
  it("is offered with a Use this button, never filled in: saving untouched creates no follow-up", async () => {
    const initial = { ...initialFor(entry({ by: "app_ai", category: "illness", summary: "s" }, [])), followUpIdea: "Call her daughter" };
    const out = renderToStaticMarkup(<DecisionForm proposalId="p" words="w" today="2026-12-01" actorId={t.clergy.id} holders={[{ id: t.clergy.id, name: "C" }]} initial={initial} />);
    expect(out).toMatch(/name="followUpTitle"[^>]*value=""/);
    expect(out).toContain('data-testid="decision-followup-idea"');
    expect(out).toContain("Use this");
    // The server makes a follow-up only from a typed title: the form's blank field makes none.
    const p = await createProposal(db, t.clergy, { rawText: "words", channel: "connector", reading: { summary: "s" }, reviewScope: "clergy" });
    const deps = { db, sf: () => ({ query: async () => [] }), now: new Date("2026-12-01T18:00:00Z") };
    const done = await acceptProposal(deps, t.clergy, p.id, { target: { kind: "new" }, person: { outsidePersonId: (await createOutsidePerson(db, t.clergy, { name: "Out Sider" })).id }, category: "illness", summary: "s" });
    expect(done.followUpId).toBeNull();
    expect(await db.select().from(followUps)).toEqual([]);
  });

  it("the Inbox asks iOS not to turn numbers into phone links", () => {
    expect(metadata.formatDetection).toEqual({ telephone: false });
  });
});

/** A proposal with a stored AI reading (a client cannot supply one, so it is written as the reader would have). */
async function withNames(text: string, names: string[]) {
  const p = await createProposal(db, t.clergy, { rawText: text, channel: "capture", reviewScope: "clergy" });
  await db.update(proposals).set({ reading: { summary: "s", by: "app_ai", names } }).where(eq(proposals.id, p.id));
}

describe("bounded matching", () => {
  it("matches only the newest 15 proposals when the list is drawn, with no more than 3 names each", async () => {
    for (let i = 0; i < 17; i++) {
      await withNames(`report ${i}`, [`Alpha${"a".repeat(i)} Smith`]);
    }
    await withNames("many names", ["Ann Z", "Bob Z", "Cal Z", "Dee Z", "Eve Z"]);
    as(t.clergy);
    state.queries = 0;
    state.maxInflight = 0;
    const out = renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }));
    const cards = count(out, 'data-testid="inbox-card"');
    expect(cards).toBeGreaterThanOrEqual(18);
    // Past the newest 15 the cards wait to be opened.
    expect(count(out, "Open to match")).toBe(cards - 15);
    // 15 cards matched: 14 with one name (one search each), and the multi-name card capped at 3 names (nicknames add searches: Bob is also Rob, Bobby...).
    expect(state.queries).toBeLessThan(15 * 4);
    expect(state.maxInflight).toBeLessThanOrEqual(4);
    expect((await db.select().from(proposals)).length).toBeGreaterThanOrEqual(18);
  });

  it("looks the same name up once, however many proposals or spellings mention it", async () => {
    let searches = 0;
    const match = createMatcher({ db, sf: () => ({ query: async () => (searches++, []) }) }, t.clergy, { maxNames: 3 });
    await Promise.all([match(["Zed Quux"]), match(["zed  QUUX"]), match(["Zed Quux", "Zed Quux"])]);
    expect(searches).toBe(1);
    const four = await match(["A1 Bb", "C1 Dd", "E1 Ff", "G1 Hh"]);
    expect(four).toHaveLength(3);
  });

  it("never runs more lookups at once than the limit, even when callers arrive as slots free up", async () => {
    let inflight = 0;
    let peak = 0;
    const sf = () => ({
      query: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return [];
      },
    });
    const match = createMatcher({ db, sf }, t.clergy, { maxNames: 40, concurrency: 3 });
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      const word = String.fromCharCode(97 + (i % 26)).repeat(3) + String.fromCharCode(97 + Math.floor(i / 26));
      calls.push(match([`Ruth${word} Cohen${word}`]));
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all(calls);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
