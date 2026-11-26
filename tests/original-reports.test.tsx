/**
 * "Original report" (Daniel, 2026-11-25: "When anyone writes, nothing should be refused. We want to maintain that
 * information because that's useful for the rabbis to see."): a decided report keeps its words, and only clergy who
 * may read them ever get them back, from the server function and on the person's page.
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { listContactEntries } from "@/server/care/contact-log";
import { submitTell } from "@/server/care/tell";
import { getDismissedReport, getOriginalReports } from "@/server/care/original-reports";
import { getPersonPage } from "@/server/care/person-page";
import { acceptProposal, createProposal, dismissProposal, listInbox, listMyReports } from "@/server/care/proposals";
import { updateUser } from "@/server/care/users";
import { NotFound } from "@/server/care/validate";
import { runDailyJob } from "@/server/daily/run";
import { auditLog, careItemAccess, careItems, jobRuns, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { meta } from "./support/meals";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/" }));

import { careViewFor } from "@/app/people/care-view";
import { PersonCare } from "@/components/person-care";

const NOW = new Date();
// Words that appear nowhere else on a page: not the person's name, not a label.
const RAW = "Her daughter rang the office: she fell on the stairs and is quite shaken";
const LEAK = /fell on the stairs|quite shaken|daughter rang/;
const SUMMARY = "In hospital after a fall";
const newItem = { target: { kind: "new" }, person: { contactId: CONTACT }, category: "illness", summary: SUMMARY };
const sensitive = { summary: SUMMARY, restrictedSuggested: true };

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
let deps: { db: Db; sf: ReturnType<typeof fakeSf>["sf"]; now: Date };

beforeEach(async () => {
  db = await testDb();
  state.db = db;
  t = await team(db);
  r = await reporters(db);
  deps = { db, sf: fakeSf().sf, now: NOW };
});

const row = async (id: string) => (await db.select().from(proposals).where(eq(proposals.id, id)))[0];
const read = async (actor: Actor, itemId: string) => ((await getOriginalReports(db, actor, [itemId])).get(itemId) ?? []).map((o) => o.words);
/** The care part of Ruth's page as this person gets it, or "" when the page itself is refused. */
async function pageFor(actor: Actor): Promise<string> {
  let page;
  try {
    page = await getPersonPage(deps, actor, CONTACT);
  } catch {
    return "";
  }
  return renderToStaticMarkup(<PersonCare view={await careViewFor(actor, page)} actor={actor} />);
}
const everyoneElse = () => [r.staff, r.lead, r.senior, t.carer, t.carer2];

describe("an accepted report keeps its words", () => {
  it("the row keeps raw_text, and loses the reading and the intake; the acceptor's own result does not carry the words", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: { summary: SUMMARY } });
    const accepted = await acceptProposal(deps, t.clergy, p.id, newItem);
    expect(await row(p.id)).toMatchObject({ status: "accepted", rawText: RAW, reading: null, intake: null, wordsPrivate: false, resultCareItemId: accepted.careItemId });
    expect(accepted.proposal.rawText).toBeNull();
    expect(words(accepted)).not.toMatch(LEAK);
  });

  it("clergy who see the item read the words, with the channel and the date, on the server and on the page; nobody else does", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    const { careItemId } = await acceptProposal(deps, t.clergy, p.id, newItem);
    await db.update(careItems).set({ visibility: "caregivers", ownerUserId: t.carer.id }).where(eq(careItems.id, careItemId));
    for (const a of [t.owner, t.clergy, t.clergy2]) {
      expect((await getOriginalReports(db, a, [careItemId])).get(careItemId)).toEqual([{ proposalId: p.id, words: RAW, channel: "staff", receivedAt: (await row(p.id)).createdAt }]);
      const html = await pageFor(a);
      expect(html).toContain('data-testid="original-report"');
      expect(html).toContain("Original report");
      expect(html).toContain("Staff report");
      expect(html).toContain(RAW);
      // Collapsed until asked for.
      expect(html).not.toMatch(/<details[^>]*data-testid="original-report"[^>]*open/);
    }
    // The caregiver holds this very item and sees it; the words are still not theirs. Nor the reporter's.
    for (const a of everyoneElse()) {
      expect(await getOriginalReports(db, a, [careItemId])).toEqual(new Map());
      const html = await pageFor(a);
      expect(html).not.toContain("original-report");
      expect(words(html)).not.toMatch(LEAK);
    }
    expect(await pageFor(t.carer)).toContain('data-testid="care-item"');
  });

  it("the words are plain text: markup in them is shown, never run", async () => {
    const p = await createProposal(db, r.staff, { rawText: '<img src=x onerror="alert(1)"> she is unwell', channel: "staff" });
    await acceptProposal(deps, t.clergy, p.id, newItem);
    const html = await pageFor(t.clergy);
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img src=x");
  });

  it("a restricted item's words are for its owner and the clergy named on it: not the acceptor, not another rabbi, not the owner role, and no stub", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    const { careItemId } = await acceptProposal(deps, t.owner, p.id, { ...newItem, category: "mental_health", restricted: true, restrictedShowsCarer: true, ownerUserId: t.clergy.id });
    expect(await read(t.clergy, careItemId)).toEqual([RAW]);
    expect(await pageFor(t.clergy)).toContain(RAW);
    for (const a of [t.owner, t.clergy2, ...everyoneElse()]) {
      expect(await read(a, careItemId)).toEqual([]);
      const html = await pageFor(a);
      expect(html).not.toContain("original-report");
      expect(words(html)).not.toMatch(LEAK);
    }
    // Named on it later: now they read it. Lifted: every rabbi does.
    await db.insert(careItemAccess).values({ careItemId, userId: t.clergy2.id });
    expect(await read(t.clergy2, careItemId)).toEqual([RAW]);
    expect(await read(t.owner, careItemId)).toEqual([]);
    await db.update(careItems).set({ restricted: false }).where(eq(careItems.id, careItemId));
    expect(await read(t.owner, careItemId)).toEqual([RAW]);
  });

  it("several reports accepted into one item are all kept, oldest first; a closed item still shows them", async () => {
    const first = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    const { careItemId } = await acceptProposal(deps, t.clergy, first.id, newItem);
    const second = await createProposal(db, r.lead, { rawText: "Second call: she is home again", channel: "staff" });
    await db.update(proposals).set({ createdAt: new Date(NOW.getTime() + 60_000) }).where(eq(proposals.id, second.id));
    await acceptProposal(deps, t.clergy2, second.id, { target: { kind: "existing", careItemId }, summary: "Home again" });
    expect(await read(t.owner, careItemId)).toEqual([RAW, "Second call: she is home again"]);
    expect(await pageFor(t.owner)).toContain("Original reports (2)");
    await db.update(careItems).set({ status: "closed", closedAt: NOW }).where(eq(careItems.id, careItemId));
    expect(await pageFor(t.owner)).toContain(RAW);
  });
});

describe("a sensitive reading: the words follow the note they became", () => {
  it("added to an existing item, the note is private to the acceptor and so are the original words", async () => {
    const existing = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: sensitive });
    await acceptProposal(deps, t.clergy, p.id, { target: { kind: "existing", careItemId: existing.id }, summary: SUMMARY });
    expect(await row(p.id)).toMatchObject({ rawText: RAW, reading: null, wordsPrivate: true, decidedBy: t.clergy.id });
    // The note: its author reads it, the item's own holder and the owner role do not.
    const noteFor = async (a: Actor) => (await listContactEntries(db, a, { careItemId: existing.id })).map((c) => [c.note, c.noteHidden]);
    expect(await noteFor(t.clergy)).toEqual([[SUMMARY, false]]);
    expect(await noteFor(t.clergy2)).toEqual([[null, true]]);
    // The words: exactly the same people.
    expect(await read(t.clergy, existing.id)).toEqual([RAW]);
    expect(await pageFor(t.clergy)).toContain(RAW);
    for (const a of [t.clergy2, t.owner, ...everyoneElse()]) {
      expect(await read(a, existing.id)).toEqual([]);
      expect(words(await pageFor(a))).not.toMatch(LEAK);
    }
    // And only while the acceptor still sees the item.
    await db.update(careItems).set({ restricted: true }).where(eq(careItems.id, existing.id));
    expect(await read(t.clergy, existing.id)).toEqual([]);
  });

  it("a report that was not marked sensitive, added to an existing item, is a note everyone on the item reads, and so are its words", async () => {
    const existing = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: { summary: SUMMARY, restrictedSuggested: false } });
    await acceptProposal(deps, t.clergy, p.id, { target: { kind: "existing", careItemId: existing.id }, summary: SUMMARY });
    expect((await row(p.id)).wordsPrivate).toBe(false);
    for (const a of [t.clergy, t.clergy2, t.owner]) expect(await read(a, existing.id)).toEqual([RAW]);
  });

  it("opened as a new item, there is no private note: the words follow the item, like the summary the acceptor wrote on it", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: sensitive });
    const { careItemId } = await acceptProposal(deps, t.clergy, p.id, { ...newItem, restricted: true, ownerUserId: t.clergy2.id });
    expect((await row(p.id)).wordsPrivate).toBe(false);
    expect(await read(t.clergy2, careItemId)).toEqual([RAW]);
    for (const a of [t.clergy, t.owner]) expect(await read(a, careItemId)).toEqual([]);
  });
});

describe("a rabbi's own capture", () => {
  it("accepted, its words are read by every rabbi who sees the entry, like any other report; a private note's words stay with the acceptor", async () => {
    const mine = await createProposal(db, t.clergy, { rawText: RAW, channel: "capture" });
    const { careItemId } = await acceptProposal(deps, t.clergy, mine.id, newItem);
    expect((await row(mine.id)).wordsPrivate).toBe(false);
    for (const a of [t.clergy, t.clergy2, t.owner]) expect(await read(a, careItemId)).toEqual([RAW]);
    // One item, two reports of different privacy: each viewer gets exactly the ones that are theirs to read.
    const hush = await createProposal(db, r.staff, { rawText: "A second note, sensitive", channel: "staff", reading: sensitive });
    await acceptProposal(deps, t.clergy2, hush.id, { target: { kind: "existing", careItemId }, summary: "Second" });
    expect((await row(hush.id)).wordsPrivate).toBe(true);
    expect(await read(t.clergy2, careItemId)).toEqual([RAW, "A second note, sensitive"]);
    for (const a of [t.clergy, t.owner]) expect(await read(a, careItemId)).toEqual([RAW]);
  });

  it("a restricted item handed to another rabbi takes its words with it: the old holder loses them, the new one reads them", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    const { careItemId } = await acceptProposal(deps, t.clergy, p.id, { ...newItem, restricted: true });
    expect(await read(t.clergy, careItemId)).toEqual([RAW]);
    await db.update(careItems).set({ ownerUserId: t.clergy2.id }).where(eq(careItems.id, careItemId));
    expect(await read(t.clergy2, careItemId)).toEqual([RAW]);
    expect(await read(t.clergy, careItemId)).toEqual([]);
  });
});

describe("a dismissed report keeps its words", () => {
  it("in the database, readable by a rabbi who could have reviewed it and by nobody else; it is shown nowhere", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: { summary: SUMMARY } });
    const result = await dismissProposal(db, t.clergy2, p.id, NOW);
    expect(result).toMatchObject({ status: "dismissed", rawText: null, reading: null });
    expect(await row(p.id)).toMatchObject({ status: "dismissed", rawText: RAW, reading: null, intake: null, resultCareItemId: null });
    for (const a of [t.owner, t.clergy, t.clergy2]) expect(await getDismissedReport(db, a, p.id)).toEqual({ proposalId: p.id, words: RAW, channel: "staff", receivedAt: (await row(p.id)).createdAt });
    for (const a of everyoneElse()) await expect(getDismissedReport(db, a, p.id)).rejects.toBeInstanceOf(NotFound);
    // Not in the Inbox, not on the person's page.
    expect(await listInbox(db, t.clergy)).toEqual([]);
    expect(words(await pageFor(t.clergy))).not.toMatch(LEAK);
  });

  it("a rabbi's own capture, dismissed, is theirs alone to read back", async () => {
    const p = await createProposal(db, t.clergy, { rawText: RAW, channel: "capture" });
    await dismissProposal(db, t.clergy, p.id, NOW);
    expect((await getDismissedReport(db, t.clergy, p.id)).words).toBe(RAW);
    for (const a of [t.clergy2, t.owner, r.staff]) await expect(getDismissedReport(db, a, p.id)).rejects.toBeInstanceOf(NotFound);
  });

  it("a pending or an accepted report, and an id that does not exist, are not found here", async () => {
    const pending = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    await expect(getDismissedReport(db, t.clergy, pending.id)).rejects.toBeInstanceOf(NotFound);
    await acceptProposal(deps, t.clergy, pending.id, newItem);
    await expect(getDismissedReport(db, t.clergy, pending.id)).rejects.toBeInstanceOf(NotFound);
    await expect(getDismissedReport(db, t.clergy, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFound);
    await expect(getDismissedReport(db, t.clergy, "nonsense")).rejects.toBeInstanceOf(NotFound);
  });

  it("a departing rabbi's own unreviewed captures are still dismissed AND erased: nobody else could ever review them", async () => {
    const p = await createProposal(db, t.clergy2, { rawText: RAW, channel: "capture" });
    await updateUser(db, t.owner, t.clergy2.id, { active: false }, new Set(["owner@example.test"]));
    expect(await row(p.id)).toMatchObject({ status: "dismissed", rawText: null, reading: null });
    for (const a of [t.owner, t.clergy]) await expect(getDismissedReport(db, a, p.id)).rejects.toBeInstanceOf(NotFound);
  });
});

describe("what did not change", () => {
  it("the sender's details: a public report's intake (who it is about, the sender's name and contact) is still cleared on the decision; only the words stay", async () => {
    const form = { about: "Ruth Cohen", what: RAW, sender: "Dana Levy", contact: "dana@example.test", mayTellThem: "no", miSheberach: "no" };
    for (let i = 0; i < 2; i++) expect(await submitTell(db, form, meta(), NOW)).toEqual({ ok: true });
    const [a, b] = await db.select().from(proposals);
    expect(a.intake).toMatchObject({ sender: "Dana Levy" });
    await dismissProposal(db, t.clergy, a.id, NOW);
    await acceptProposal(deps, t.clergy, b.id, newItem);
    for (const p of await db.select().from(proposals)) {
      expect(p).toMatchObject({ rawText: RAW, intake: null, reporterName: null, reporterEmail: null });
      expect(words(p)).not.toMatch(/Dana|dana@/);
    }
  });

  it("a reporter's own list is still a date, a status and who picked it up, and never the words", async () => {
    const dismissed = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    const picked = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    await dismissProposal(db, t.clergy, dismissed.id);
    await acceptProposal(deps, t.clergy, picked.id, newItem);
    const mine = await listMyReports(db, r.staff);
    expect(mine).toHaveLength(2);
    for (const m of mine) expect(Object.keys(m).sort()).toEqual(["createdOn", "id", "pickedUpBy", "status"]);
    expect(words(mine)).not.toMatch(LEAK);
  });

  it("no audit row and no log line holds the words, through accept, dismiss, reading them back and the daily job", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log").mockImplementation(() => {}));
    const a = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: sensitive });
    const b = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    const { careItemId } = await acceptProposal(deps, t.clergy, a.id, { ...newItem, restricted: true });
    await dismissProposal(db, t.clergy, b.id, NOW);
    await getOriginalReports(db, t.clergy, [careItemId]);
    await getDismissedReport(db, t.clergy, b.id);
    await getDismissedReport(db, r.staff, b.id).catch(() => null);
    await pageFor(t.clergy);
    await runDailyJob({ db, now: new Date(NOW.getTime() + 86_400_000), owners: new Set(["owner@example.test"]), origin: null });
    const audit = await db.select().from(auditLog);
    expect(audit.length).toBeGreaterThan(1);
    expect(words(audit)).not.toMatch(LEAK);
    expect(words(await db.select().from(jobRuns))).not.toMatch(LEAK);
    expect(words(logs.flatMap((l) => l.mock.calls))).not.toMatch(LEAK);
    logs.forEach((l) => l.mockRestore());
    // And the job left both sets of words where they were.
    expect((await db.select().from(proposals)).map((p) => p.rawText)).toEqual([RAW, RAW]);
  });
});
