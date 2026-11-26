/**
 * "Closed without action" on screen: the Inbox's quiet link with its count, the page of dismissed reports with their
 * words as plain text, Reopen, and everyone below clergy level sent away.
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { CLOSED_PAGE_SIZE } from "@/server/care/closed-reports";
import { createProposal, dismissProposal } from "@/server/care/proposals";
import { proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { reporters, team, testDb } from "./support/db";
import { words } from "./support/words";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { acceptProposalAction, reopenProposalAction } from "@/app/inbox-actions";
import InboxPage from "@/app/inbox/page";
import ClosedReportsPage from "@/app/inbox/closed/page";
import { InboxCard } from "@/components/inbox-card";

const RAW = "Her son wrote in: she is low and not eating";
const LEAK = /low and not eating|Her son wrote/;
const IDLE = { status: "idle" } as never;

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const inbox = async (actor: Actor) => {
  as(actor);
  return renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }));
};
const closed = async (actor: Actor, before?: string) => {
  as(actor);
  return renderToStaticMarkup(await ClosedReportsPage({ searchParams: Promise.resolve(before ? { before } : {}) }));
};

beforeEach(async () => {
  process.env.OWNER_EMAILS = "owner@example.test";
  db = await testDb();
  state.db = db;
  t = await team(db);
  r = await reporters(db);
});

describe("the Inbox's link", () => {
  it("appears only when there are dismissed reports this viewer may read, with their count", async () => {
    for (const a of [t.owner, t.clergy, t.clergy2]) expect(await inbox(a)).not.toContain("inbox-closed-link");
    const shared = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    await dismissProposal(db, t.clergy, shared.id);
    const mine = await createProposal(db, t.clergy, { rawText: "My own capture", channel: "capture" });
    await dismissProposal(db, t.clergy, mine.id);
    expect(await inbox(t.clergy)).toContain("Closed without action (2)");
    for (const a of [t.owner, t.clergy2]) {
      const html = await inbox(a);
      expect(html).toContain('data-testid="inbox-closed-link"');
      expect(html).toContain('href="/inbox/closed"');
      expect(html).toContain("Closed without action (1)");
    }
    // A capture whose only reader is someone else counts for nobody else.
    expect(await inbox(t.clergy2)).not.toContain("Closed without action (2)");
  });

  it("the dismiss confirmation says where the words are kept", async () => {
    await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    expect(await inbox(t.clergy)).toContain("The words are kept for the rabbis, under Closed without action, at the foot of the Inbox.");
  });
});

describe("the page", () => {
  it("shows each report's source, dates, who closed it and its words as escaped text, with Reopen", async () => {
    const p = await createProposal(db, r.staff, { rawText: `<img src=x onerror="alert(1)"> ${RAW}`, channel: "staff" });
    await dismissProposal(db, t.clergy2, p.id);
    const html = await closed(t.clergy);
    expect(html).toContain('data-testid="closed-report"');
    expect(html).toContain("staff · Staff report");
    expect(html).toContain("by clergy2");
    expect(html).toContain(RAW);
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(">Reopen<");
    expect(html).not.toContain("closed-older");
  });

  it("says so when there are none, and pages 25 at a time with an id in the link", async () => {
    expect(await closed(t.clergy)).toContain('data-testid="closed-empty"');
    const now = Date.now();
    for (let i = 0; i < CLOSED_PAGE_SIZE + 2; i++) {
      const p = await createProposal(db, r.staff, { rawText: `Report ${i}`, channel: "staff" });
      await dismissProposal(db, t.clergy, p.id, new Date(now - i * 60_000));
    }
    const first = await closed(t.clergy);
    expect(first.match(/data-testid="closed-report"/g)).toHaveLength(CLOSED_PAGE_SIZE);
    const next = first.match(/href="\/inbox\/closed\?before=([0-9a-f-]{36})"/);
    expect(next).not.toBeNull();
    const second = await closed(t.clergy, next![1]);
    expect(second.match(/data-testid="closed-report"/g)).toHaveLength(2);
    expect(second).toContain("Report 26");
    expect(second).toContain("Back to the newest");
    // A cursor that is not an id starts from the newest.
    expect((await closed(t.clergy, "nonsense")).match(/data-testid="closed-report"/g)).toHaveLength(CLOSED_PAGE_SIZE);
  });

  it("sends staff, leads, senior staff and caregivers away, as the Inbox does", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    await dismissProposal(db, t.clergy, p.id);
    for (const a of [r.staff, r.lead, r.senior, t.carer, t.carer2]) {
      as(a);
      await expect(ClosedReportsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/redirect/);
      await expect(InboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/redirect/);
      expect(await reopenProposalAction(IDLE, form({ proposalId: p.id }))).toMatchObject({ status: "error" });
    }
    expect((await db.select().from(proposals))[0].status).toBe("dismissed");
  });
});

describe("Reopen on screen", () => {
  it("puts it back in the Inbox, where the card shows the words with no reading and Accept saves it", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: { summary: "Low", category: "illness" } });
    await dismissProposal(db, t.clergy, p.id);
    as(t.clergy2);
    expect(await reopenProposalAction(IDLE, form({ proposalId: p.id }))).toEqual({ status: "ok", message: "Back in the Inbox." });
    expect(await reopenProposalAction(IDLE, form({ proposalId: p.id }))).toMatchObject({ status: "error" });
    expect(await closed(t.clergy)).toContain('data-testid="closed-empty"');
    const html = await inbox(t.clergy);
    expect(html).toContain('data-testid="inbox-card"');
    expect(html).toContain(RAW);
    expect(html).not.toContain('data-testid="inbox-reading"');
    expect(html).not.toContain("inbox-closed-link");
    // The accept sheet's own fields, as decisionFrom reads them.
    as(t.clergy);
    expect(await acceptProposalAction(IDLE, form({ proposalId: p.id, newName: "Ruth Cohen", category: "illness", summary: "Low" }))).toMatchObject({ status: "ok" });
    expect((await db.select().from(proposals).where(eq(proposals.id, p.id)))[0]).toMatchObject({ status: "accepted", reading: null, intake: null });
  });

  it("the Inbox card copes with a pending report that has words but no reading and no intake", () => {
    const proposal = { id: "00000000-0000-4000-8000-000000000009", channel: "form", rawText: RAW, reading: null, intake: null, submittedBy: null, submitterName: "Public form", createdAt: new Date(), miSheberachAnswer: "yes", mayTellThem: "yes", practical: false, leadVisible: false, takenByName: null } as never;
    const html = renderToStaticMarkup(<InboxCard entry={{ proposal, person: null, candidates: [], existing: [], nameMatches: [], matchPending: false, canReread: true, suggestedOwnerName: null, own: false, intake: null }} today="2026-11-25" actorId={t.clergy.id} holders={[]} />);
    expect(html).toContain("Someone, not yet matched");
    expect(html).toContain(RAW);
    expect(html).toContain("Read it again");
    expect(words(html)).not.toMatch(/Unverified/);
    expect(words(html)).toMatch(LEAK);
  });
});
