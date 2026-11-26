/**
 * "Closed without action": the dismissed reports whose words a rabbi may read back, and Reopen. Who sees which rows is
 * exactly getDismissedReport's rule, decided in SQL: the shared Inbox's for every rabbi, a rabbi's own capture for that
 * rabbi alone, and nobody else at all (not even a count).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { countClosedReports, listClosedReports, reopenProposal, CLOSED_PAGE_SIZE } from "@/server/care/closed-reports";
import { getDismissedReport } from "@/server/care/original-reports";
import { acceptProposal, createProposal, dismissProposal, listInbox, listMyReports } from "@/server/care/proposals";
import { submitTell } from "@/server/care/tell";
import { updateUser } from "@/server/care/users";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CONTACT, reporters, team, testDb } from "./support/db";
import { meta } from "./support/meals";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

const NOW = new Date();
const RAW = "Her neighbour wrote: he has not been out of the house since the funeral";
const MINE = "My own note: the Gold family, a hard week";
const LEAK = /not been out of the house|since the funeral|hard week|Gold family/;
const newItem = { target: { kind: "new" }, person: { contactId: CONTACT }, category: "illness", summary: "A hard time" };

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
});

const row = async (id: string) => (await db.select().from(proposals).where(eq(proposals.id, id)))[0];
const listed = async (a: Actor) => (await listClosedReports(db, a)).reports.map((x) => x.words);
const everyoneElse = () => [r.staff, r.lead, r.senior, t.carer, t.carer2];
/** A shared report from staff, dismissed by clergy2, and clergy's own capture, dismissed by clergy. */
async function both() {
  const shared = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading: { summary: "s" } });
  await dismissProposal(db, t.clergy2, shared.id, NOW);
  const mine = await createProposal(db, t.clergy, { rawText: MINE, channel: "capture" });
  await dismissProposal(db, t.clergy, mine.id, new Date(NOW.getTime() + 60_000));
  return { shared, mine };
}

describe("who sees which dismissed reports", () => {
  it("the shared Inbox's for every rabbi; a rabbi's own capture for that rabbi alone; the same rule as getDismissedReport", async () => {
    const { shared, mine } = await both();
    expect(await listed(t.clergy)).toEqual([MINE, RAW]);
    expect(await countClosedReports(db, t.clergy)).toBe(2);
    for (const a of [t.clergy2, t.owner]) {
      expect(await listed(a)).toEqual([RAW]);
      expect(await countClosedReports(db, a)).toBe(1);
      await expect(getDismissedReport(db, a, mine.id)).rejects.toBeInstanceOf(NotFound);
    }
    for (const a of [t.owner, t.clergy, t.clergy2]) expect((await getDismissedReport(db, a, shared.id)).words).toBe(RAW);
  });

  it("each row carries the dates, who closed it, the channel and where it came from, and nothing of the reading or the intake", async () => {
    const { shared, mine } = await both();
    const { reports } = await listClosedReports(db, t.clergy);
    expect(reports).toEqual([
      { id: mine.id, channel: "capture", receivedAt: (await row(mine.id)).createdAt, closedAt: new Date(NOW.getTime() + 60_000), closedByName: "clergy", from: "clergy", ownCapture: true, words: MINE },
      { id: shared.id, channel: "staff", receivedAt: (await row(shared.id)).createdAt, closedAt: NOW, closedByName: "clergy2", from: "staff", ownCapture: false, words: RAW },
    ]);
  });

  it("a report with no submitter shows its source's label", async () => {
    const form = { about: "Ruth Cohen", what: RAW, sender: "Dana Levy", contact: "dana@example.test", mayTellThem: "no", miSheberach: "no" };
    expect(await submitTell(db, form, meta(), NOW)).toEqual({ ok: true });
    const [p] = await db.select().from(proposals);
    await dismissProposal(db, t.clergy, p.id, NOW);
    const [only] = (await listClosedReports(db, t.owner)).reports;
    expect(only).toMatchObject({ channel: "form", from: "Public form", words: RAW });
    expect(words(only)).not.toMatch(/Dana|dana@/);
  });

  it("staff, leads, senior staff and caregivers are refused, the count included", async () => {
    await both();
    for (const a of everyoneElse()) {
      await expect(listClosedReports(db, a)).rejects.toBeInstanceOf(AccessDenied);
      await expect(countClosedReports(db, a)).rejects.toBeInstanceOf(AccessDenied);
      await expect(reopenProposal(db, a, (await db.select().from(proposals))[0].id)).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("rows with no words are left out: a departed rabbi's erased captures, and a report that came with a reading only", async () => {
    const gone = await createProposal(db, t.clergy2, { rawText: MINE, channel: "capture", reviewScope: "clergy" });
    const own = await createProposal(db, t.clergy2, { rawText: MINE, channel: "capture" });
    const readingOnly = await createProposal(db, r.staff, { channel: "connector", reading: { summary: "Only a reading" } });
    await dismissProposal(db, t.clergy, readingOnly.id, NOW);
    await updateUser(db, t.owner, t.clergy2.id, { active: false }, new Set(["owner@example.test"]));
    // The erasure itself is unchanged: dismissed, words gone.
    expect(await row(own.id)).toMatchObject({ status: "dismissed", rawText: null });
    // The one released to the shared Inbox was not theirs alone, so it is still pending with its words.
    expect(await row(gone.id)).toMatchObject({ status: "pending", rawText: MINE });
    for (const a of [t.owner, t.clergy]) {
      expect(await listed(a)).toEqual([]);
      expect(await countClosedReports(db, a)).toBe(0);
      await expect(reopenProposal(db, a, own.id)).rejects.toBeInstanceOf(NotFound);
      await expect(reopenProposal(db, a, readingOnly.id)).rejects.toBeInstanceOf(NotFound);
    }
  });
});

describe("order and paging", () => {
  it("newest closed first, 25 at a time, with a cursor that is an id; the pages meet exactly", async () => {
    const ids: string[] = [];
    for (let i = 0; i < CLOSED_PAGE_SIZE + 5; i++) {
      const p = await createProposal(db, r.staff, { rawText: `Report number ${i}`, channel: "staff" });
      // Closed in a different order from arrival: the list follows the closing.
      await dismissProposal(db, t.clergy, p.id, new Date(NOW.getTime() - ((i * 7) % 30) * 3_600_000));
      ids.push(p.id);
    }
    const first = await listClosedReports(db, t.clergy2);
    expect(first.reports).toHaveLength(CLOSED_PAGE_SIZE);
    expect(first.older).toBe(first.reports[CLOSED_PAGE_SIZE - 1].id);
    const second = await listClosedReports(db, t.clergy2, { before: first.older });
    expect(second.reports).toHaveLength(5);
    expect(second.older).toBeNull();
    const all = [...first.reports, ...second.reports];
    expect(new Set(all.map((x) => x.id))).toEqual(new Set(ids));
    const times = all.map((x) => x.closedAt!.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("ties on the closing time are split by id, never repeated or dropped", async () => {
    for (let i = 0; i < CLOSED_PAGE_SIZE + 3; i++) {
      const p = await createProposal(db, r.staff, { rawText: `Same moment ${i}`, channel: "staff" });
      await dismissProposal(db, t.clergy, p.id, NOW);
    }
    const first = await listClosedReports(db, t.clergy);
    const second = await listClosedReports(db, t.clergy, { before: first.older });
    expect(new Set([...first.reports, ...second.reports].map((x) => x.id)).size).toBe(CLOSED_PAGE_SIZE + 3);
  });

  it("a cursor the viewer may not review gives nothing; a cursor that is not an id is refused", async () => {
    const { mine } = await both();
    expect((await listClosedReports(db, t.clergy2, { before: mine.id })).reports).toEqual([]);
    await expect(listClosedReports(db, t.clergy2, { before: "nonsense" })).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("Reopen", () => {
  it("puts it back in the Inbox as pending, with no reading and no intake; the reporter's own list says pending again", async () => {
    const { shared } = await both();
    expect((await listMyReports(db, r.staff))[0].status).toBe("dismissed");
    expect(await reopenProposal(db, t.owner, shared.id)).toEqual({ id: shared.id });
    expect(await row(shared.id)).toMatchObject({ status: "pending", decidedBy: null, decidedAt: null, reading: null, intake: null, rawText: RAW, resultCareItemId: null });
    for (const a of [t.owner, t.clergy, t.clergy2]) expect((await listInbox(db, a)).map((p) => [p.id, p.rawText, p.reading])).toEqual([[shared.id, RAW, null]]);
    expect(await listed(t.owner)).toEqual([]);
    const mineList = await listMyReports(db, r.staff);
    expect(mineList).toEqual([{ id: shared.id, createdOn: expect.any(String), status: "pending", pickedUpBy: null }]);
    // Dismissed again, it is back on the list.
    await dismissProposal(db, t.clergy, shared.id, NOW);
    expect(await listed(t.owner)).toEqual([RAW]);
  });

  it("a rabbi's own capture is reopened by that rabbi only, and goes back to their own captures, not the shared Inbox", async () => {
    const { mine } = await both();
    for (const a of [t.clergy2, t.owner]) await expect(reopenProposal(db, a, mine.id)).rejects.toBeInstanceOf(NotFound);
    await reopenProposal(db, t.clergy, mine.id);
    expect((await listInbox(db, t.clergy)).map((p) => p.id)).toEqual([mine.id]);
    expect(await listInbox(db, t.clergy2)).toEqual([]);
    expect((await row(mine.id)).reviewScope).toBe("submitter");
  });

  it("is refused for a report that is not closed (pending, accepted) and for one that does not exist", async () => {
    const pending = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    await expect(reopenProposal(db, t.clergy, pending.id)).rejects.toBeInstanceOf(InvalidInput);
    await acceptProposal({ db, sf: fakeSf().sf, now: NOW }, t.clergy, pending.id, newItem);
    await expect(reopenProposal(db, t.clergy, pending.id)).rejects.toBeInstanceOf(InvalidInput);
    expect((await row(pending.id)).status).toBe("accepted");
    await expect(reopenProposal(db, t.clergy, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFound);
    await expect(reopenProposal(db, t.clergy, "nonsense")).rejects.toBeInstanceOf(NotFound);
  });

  it("happens once: of two at the same moment one reopens it and the other is told it is no longer closed; one audit row", async () => {
    const { shared } = await both();
    const results = await Promise.allSettled([reopenProposal(db, t.clergy, shared.id), reopenProposal(db, t.clergy2, shared.id)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(InvalidInput);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "proposal.reopen"))).toHaveLength(1);
  });

  it("leaves one audit row of ids and the channel, and no words anywhere in the audit or the logs", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log").mockImplementation(() => {}));
    const { shared, mine } = await both();
    await listClosedReports(db, t.clergy);
    await reopenProposal(db, t.clergy, shared.id);
    await reopenProposal(db, t.clergy, mine.id);
    await reopenProposal(db, t.clergy2, mine.id).catch(() => null);
    const reopens = await db.select().from(auditLog).where(eq(auditLog.action, "proposal.reopen"));
    expect(reopens.map((a) => [a.actorUserId, a.subjectType, a.subjectId, a.detail])).toEqual([
      [t.clergy.id, "proposal", shared.id, { channel: "staff" }],
      [t.clergy.id, "proposal", mine.id, { channel: "capture" }],
    ]);
    expect(words(await db.select().from(auditLog))).not.toMatch(LEAK);
    expect(words(logs.flatMap((l) => l.mock.calls))).not.toMatch(LEAK);
    logs.forEach((l) => l.mockRestore());
  });

  it("a reopened report has no reading and no intake, and is accepted like any other; a public one simply has no sender", async () => {
    const form = { about: "Ruth Cohen", what: RAW, sender: "Dana Levy", contact: "dana@example.test", mayTellThem: "yes", miSheberach: "yes" };
    expect(await submitTell(db, form, meta(), NOW)).toEqual({ ok: true });
    const [p] = await db.select().from(proposals);
    await dismissProposal(db, t.clergy, p.id, NOW);
    await reopenProposal(db, t.clergy, p.id);
    expect(await row(p.id)).toMatchObject({ status: "pending", reading: null, intake: null, rawText: RAW });
    const done = await acceptProposal({ db, sf: fakeSf().sf, now: NOW }, t.clergy, p.id, newItem);
    expect(await row(p.id)).toMatchObject({ status: "accepted", resultCareItemId: done.careItemId, decidedBy: t.clergy.id, reporterName: null, reporterEmail: null });
  });
});
