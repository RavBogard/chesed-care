import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { closeCareItem, createCareItem, reopenCareItem, updateCareItem } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp, setFollowUpDone } from "@/server/care/follow-ups";
import { createProposal, dismissProposal } from "@/server/care/proposals";
import { auditLog, captureTokens, careItems, contactLog, dailySummaries, followUps, jobRuns, mealRateLimits, proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import * as housekeeping from "@/server/daily/housekeeping";
import { pruneRateLimits, revokeIdleCaptureTokens } from "@/server/daily/housekeeping";
import { handleDailyRequest, isScheduledCall } from "@/server/daily/request";
import { DAILY_TASKS, jobIsOverdue, latestJobRuns, runDailyJob } from "@/server/daily/run";
import { computeSummary, deliverSummary, effectivePref, getMorningSummary, getSummaryPref, runMorningSummaries, setSummaryPref, summaryMessage } from "@/server/daily/summary";
import { startJourney } from "@/server/journeys/journeys";
import { ACCOUNT, addActor, CONTACT, CONTACT2, team, testDb } from "./support/db";
import { words } from "./support/words";

const SECRET = "a-secret-of-at-least-16-chars";
const NOW = new Date("2026-11-25T12:00:00Z");
const OWNERS: ReadonlySet<string> = new Set(["owner@example.test"]);
const NOTE = "She is frightened about the scan";

afterEach(() => vi.restoreAllMocks());

describe("the daily job's door", () => {
  it("only the scheduler's bearer secret opens it; anything else is the same 401 and runs nothing", async () => {
    const db = await testDb();
    const run = vi.fn(async () => ({ n: 1 }));
    const call = (authorization: string | null, secret: string | undefined) => handleDailyRequest({ authorization, secret, db: () => db, now: NOW, owners: OWNERS, origin: null, tasks: [{ key: "probe", run }] });
    const refused = [
      await call(null, SECRET),
      await call(`Bearer ${SECRET}x`, SECRET),
      await call(`bearer ${SECRET}`, SECRET),
      await call(SECRET, SECRET),
      // No secret configured, or one too short: every call is refused.
      await call("Bearer ", undefined),
      await call("Bearer short", "short"),
    ];
    const bodies = await Promise.all(refused.map(async (r) => [r.status, await r.text()]));
    expect(new Set(bodies.map((b) => JSON.stringify(b)))).toEqual(new Set([JSON.stringify([401, '{"ok":false}'])]));
    expect(run).not.toHaveBeenCalled();
    expect(await db.select().from(jobRuns)).toEqual([]);

    const ok = await call(`Bearer ${SECRET}`, SECRET);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, tasks: [{ task: "probe", ok: true }] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(isScheduledCall(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("the route reads CRON_SECRET from the environment and answers 401 without it", async () => {
    const db = await testDb();
    vi.doMock("@/server/db/client", () => ({ getDb: () => db }));
    const route = await import("@/app/api/cron/daily/route");
    const { POST } = route;
    // Only the method the schedule uses.
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["POST"]);
    const req = (auth?: string) => new Request("https://care.example.test/api/cron/daily", { method: "POST", headers: auth ? { authorization: auth } : {} });
    const saved = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      expect((await POST(req(`Bearer ${SECRET}`))).status).toBe(401);
      process.env.CRON_SECRET = SECRET;
      expect((await POST(req())).status).toBe(401);
      expect((await POST(req("Bearer wrong-secret-entirely"))).status).toBe(401);
      expect(await db.select().from(jobRuns)).toEqual([]);
      const res = await POST(req(`Bearer ${SECRET}`));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tasks: { task: string }[] }).tasks.map((t) => t.task)).toEqual(DAILY_TASKS.map((t) => t.key));
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
      vi.doUnmock("@/server/db/client");
    }
  });

  it("runs the tasks in order, each on its own: a failure is recorded by its error's name only and the rest still run", async () => {
    const db = await testDb();
    const order: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class SecretLeak extends Error {
      constructor() {
        super(NOTE);
        this.name = "SecretLeak";
      }
    }
    const results = await runDailyJob({ db, now: NOW, owners: OWNERS, origin: null }, [
      { key: "first", run: async () => (order.push("first"), { a: 1 }) },
      { key: "broken", run: async () => (order.push("broken"), Promise.reject(new SecretLeak())) },
      { key: "last", run: async () => (order.push("last"), { b: 2 }) },
    ]);
    expect(order).toEqual(["first", "broken", "last"]);
    expect(results.map((r) => [r.task, r.ok, r.errorName])).toEqual([
      ["first", true, null],
      ["broken", false, "SecretLeak"],
      ["last", true, null],
    ]);
    const rows = await db.select().from(jobRuns);
    expect(rows.map((r) => [r.task, r.ok, r.errorName, r.counts]).sort()).toEqual(
      [
        ["broken", false, "SecretLeak", null],
        ["first", true, null, { a: 1 }],
        ["last", true, null, { b: 2 }],
      ].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain(NOTE);
    expect(JSON.stringify(error.mock.calls)).not.toContain(NOTE);
  });

  it("the real tasks all run on an empty database, and the owner alone sees the last run of each", async () => {
    const db = await testDb();
    const t = await team(db);
    const results = await runDailyJob({ db, now: NOW, owners: OWNERS, origin: "https://care.example.test" });
    expect(results.map((r) => [r.task, r.ok])).toEqual(DAILY_TASKS.map((x) => [x.key, true]));
    const runs = await latestJobRuns(db, t.owner);
    expect(runs.map((r) => r.task)).toEqual(DAILY_TASKS.map((x) => x.key));
    for (const a of [t.clergy, t.carer]) await expect(latestJobRuns(db, a)).rejects.toBeInstanceOf(AccessDenied);
  });
});

// Daniel, 2026-11-25: "I want it all kept." The three-year clearing of a closed item's notes is retired, and with it
// the "keep notes" switch. These were the tests of that purge; each is now a test that nothing is cleared.
describe("care notes are kept: nothing clears them on a timer", () => {
  const DAY = 86_400_000;
  // Counted from the real clock as well as from NOW: rows are stamped by the database's own clock.
  const YEARS = [3, 5, 10];
  const runAt = (db: Db, at: Date) => runDailyJob({ db, now: at, owners: OWNERS, origin: null });
  async function closedItem(db: Db, t: Awaited<ReturnType<typeof team>>, closedAt: Date, extra: Partial<typeof careItems.$inferInsert> = {}, contact = CONTACT) {
    const item = await createCareItem(db, t.clergy, { sfContactId: contact, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: NOTE, location: "Barnes, room 4", learnedFrom: "Her daughter" });
    await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "call", occurredAt: new Date("2023-01-01T12:00:00Z"), note: NOTE });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Ask about the scan", dueDate: "2023-01-05" });
    await db.update(careItems).set({ status: "closed", closedAt, corpsNote: "Meals on Tuesdays", ...extra }).where(eq(careItems.id, item.id));
    return item;
  }
  const snapshot = async (db: Db) => ({
    items: (await db.select().from(careItems)).map((c) => [c.id, c.summary, c.location, c.learnedFrom, c.corpsNote, c.status, c.closedAt?.getTime(), c.notesPurgedAt]).sort(),
    contacts: (await db.select().from(contactLog)).map((c) => [c.id, c.note, c.kind]).sort(),
    followUps: (await db.select().from(followUps)).map((f) => [f.id, f.title, f.outcomeNote, f.dueDate]).sort(),
  });

  it("3, 5 and 10 years after closing, the daily job leaves the item's text, its contact notes and its follow-ups exactly as written, and audits no purge", async () => {
    const db = await testDb();
    const t = await team(db);
    const now = new Date();
    await closedItem(db, t, new Date(now.getTime() - 4 * 365 * DAY));
    await closedItem(db, t, now, {}, CONTACT2);
    const before = await snapshot(db);
    expect(before.items.every((i) => i[1] === NOTE && i[7] === null)).toBe(true);
    for (const years of YEARS) {
      const results = await runAt(db, new Date(now.getTime() + (years * 366 + 1) * DAY));
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(await snapshot(db)).toEqual(before);
    }
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "care_item.notes_purged"))).toEqual([]);
    // No task of the daily job is the note purge any more, and none reports notes cleared.
    expect(DAILY_TASKS.map((x) => x.key)).not.toContain("note_retention");
    expect(JSON.stringify(await db.select().from(jobRuns))).not.toMatch(/note_retention|contacts|"items"/);
  });

  it("journey steps too: an edited step title and a lead's outcome line are still there years after the item closed", async () => {
    const db = await testDb();
    const t = await team(db);
    const lead = await addActor(db, "lead@example.test", "lead");
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement", summary: NOTE });
    await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: "2023-01-01" }, new Date("2023-01-02T12:00:00Z"));
    const journeySteps = await db.select().from(followUps).where(eq(followUps.careItemId, item.id));
    const clergyStep = journeySteps.find((f) => !f.forLead)!;
    const leadStep = journeySteps.find((f) => f.forLead && f.ownerUserId === lead.id)!;
    await db.update(followUps).set({ title: "Ask how the chemo is going" }).where(eq(followUps.id, clergyStep.id));
    await db.update(followUps).set({ doneAt: new Date("2023-01-03T12:00:00Z"), outcomeNote: "She cried about the diagnosis" }).where(eq(followUps.id, leadStep.id));
    await db.update(careItems).set({ status: "closed", closedAt: new Date(Date.now() - 10 * 366 * DAY) }).where(eq(careItems.id, item.id));
    await runAt(db, new Date());
    await runAt(db, new Date(Date.now() + 10 * 366 * DAY));
    const after = await db.select().from(followUps).where(eq(followUps.careItemId, item.id));
    expect(after).toHaveLength(journeySteps.length);
    expect(after.find((f) => f.id === clergyStep.id)?.title).toBe("Ask how the chemo is going");
    expect(after.find((f) => f.id === leadStep.id)).toMatchObject({ outcomeNote: "She cried about the diagnosis", doneAt: new Date("2023-01-03T12:00:00Z") });
  });

  it("with or without the old keep flag, whatever the item's state, and restricted or not: nothing is cleared, and nobody is recorded as reading", async () => {
    const db = await testDb();
    const t = await team(db);
    const old = new Date(Date.now() - 5 * 366 * DAY);
    const all = [
      await closedItem(db, t, old),
      await closedItem(db, t, old, { keepNotes: true }),
      // "Keep" switched off long ago: under the old rule this one was past its 30 days of grace.
      await closedItem(db, t, old, { keepNotes: false, notesUnkeptAt: new Date(Date.now() - 400 * DAY) }),
      await closedItem(db, t, old, { status: "open" }),
      await closedItem(db, t, old, { status: "new" }),
      await closedItem(db, t, old, { status: "paused", pausedUntil: "2099-01-01" }),
      await closedItem(db, t, old, { restricted: true }, CONTACT2),
    ];
    const before = await snapshot(db);
    for (const years of [0, ...YEARS]) await runAt(db, new Date(Date.now() + years * 366 * DAY));
    expect(await snapshot(db)).toEqual(before);
    const rows = await db.select({ id: careItems.id, summary: careItems.summary }).from(careItems);
    expect(all.map((i) => rows.find((r) => r.id === i.id)!.summary)).toEqual(all.map(() => NOTE));
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "restricted.view"))).toEqual([]);
  });

  it("the 'keep notes' switch is gone: no server function sets it, and no audit row of it is written any more", async () => {
    const db = await testDb();
    const t = await team(db);
    const careItemsModule = await import("@/server/care/care-items");
    const policy = await import("@/server/access/policy");
    expect(Object.keys(careItemsModule)).not.toContain("setKeepNotes");
    expect(Object.keys(policy)).not.toContain("canSetKeepNotes");
    const item = await closedItem(db, t, new Date("2026-01-10T12:00:00Z"));
    await runAt(db, new Date());
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0]).toMatchObject({ keepNotes: false, notesUnkeptAt: null, notesPurgedAt: null, summary: NOTE });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "care_item.keep_notes"))).toEqual([]);
  });
});

describe("housekeeping", () => {
  it("revokes capture keys unused for 180 days, deletes expired rate-limit rows, and leaves a decided proposal's words alone", async () => {
    const db = await testDb();
    const t = await team(db);
    const day = 86_400_000;
    const [idle, used, fresh] = await db
      .insert(captureTokens)
      .values([
        { userId: t.clergy.id, tokenHash: "a", prefix: "ccap_a", createdAt: new Date(NOW.getTime() - 200 * day) },
        { userId: t.clergy.id, tokenHash: "b", prefix: "ccap_b", createdAt: new Date(NOW.getTime() - 200 * day), lastUsedAt: new Date(NOW.getTime() - 10 * day) },
        { userId: t.clergy.id, tokenHash: "c", prefix: "ccap_c", createdAt: new Date(NOW.getTime() - 179 * day) },
      ])
      .returning();
    expect(await revokeIdleCaptureTokens(db, NOW)).toBe(1);
    const tokens = await db.select().from(captureTokens);
    expect(tokens.filter((k) => k.revokedAt).map((k) => k.id)).toEqual([idle.id]);
    expect([used.id, fresh.id].every((id) => tokens.find((k) => k.id === id)!.revokedAt === null)).toBe(true);

    await db.insert(mealRateLimits).values([
      { key: "signup:x", windowStart: new Date(NOW.getTime() - 3 * 3_600_000) },
      { key: "signup:y", windowStart: new Date(NOW.getTime() - 3_600_000) },
      { key: "day:z", windowStart: new Date(NOW.getTime() - 3 * day) },
      { key: "day:w", windowStart: new Date(NOW.getTime() - day) },
    ]);
    expect(await pruneRateLimits(db, NOW)).toBe(2);
    expect((await db.select().from(mealRateLimits)).map((r) => r.key).sort()).toEqual(["day:w", "signup:y"]);

    // A decided proposal keeps its words (Daniel, 2026-11-25), so the old self-check "decided proposals with words: expect 0" is gone:
    // the job neither counts them nor clears them, however long ago the decision was.
    expect(Object.keys(housekeeping)).not.toContain("countDecidedWithWords");
    const p = await createProposal(db, t.clergy, { rawText: NOTE, channel: "capture" });
    await dismissProposal(db, t.clergy, p.id, new Date(Date.now() - 10 * 366 * day));
    for (const years of [0, 3, 10]) {
      const results = await runDailyJob({ db, now: new Date(Date.now() + years * 366 * day), owners: OWNERS, origin: null });
      expect(results.find((r) => r.task === "housekeeping")?.counts).not.toHaveProperty("decidedProposalsWithWords");
      expect((await db.select().from(proposals))[0]).toMatchObject({ status: "dismissed", rawText: NOTE });
    }
    expect(JSON.stringify(await db.select().from(jobRuns))).not.toContain(NOTE);
  });

  it("the standing check-in safety net makes a missing next step, once", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "ongoing" });
    const { journeyId, followUpIds } = await startJourney(db, t.clergy, item.id, { templateKey: "standing", anchorDate: "2026-11-01", intervalWeeks: 1 }, new Date("2026-11-01T12:00:00Z"));
    // Done behind the app's back: no next step was made.
    await db.update(followUps).set({ doneAt: new Date("2026-11-08T12:00:00Z") }).where(eq(followUps.id, followUpIds[0]));
    const task = DAILY_TASKS.find((x) => x.key === "standing_check_ins")!;
    expect(await task.run({ db, now: NOW, owners: OWNERS, origin: null })).toEqual({ checked: 1, made: 1 });
    expect(await task.run({ db, now: NOW, owners: OWNERS, origin: null })).toEqual({ checked: 0, made: 0 });
    const open = (await db.select().from(followUps).where(eq(followUps.journeyId, journeyId))).filter((f) => !f.doneAt);
    // A week after it was done would be in the past: due today.
    expect(open.map((f) => f.dueDate)).toEqual(["2026-11-25"]);
  });
});

describe("the morning summary", () => {
  async function scene() {
    const db = await testDb();
    const t = await team(db);
    const lead = await addActor(db, "lead@example.test", "lead");
    const staff = await addActor(db, "staff@example.test", "staff");
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement", summary: NOTE });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Overdue call", dueDate: "2026-11-20" });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Today's visit", dueDate: "2026-11-25" });
    const done = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Done", dueDate: "2026-11-20" });
    await setFollowUpDone(db, t.clergy, done.id, true);
    await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: "2026-11-24" }, new Date("2026-11-24T20:00:00Z"));
    await createProposal(db, staff, { rawText: NOTE, channel: "staff" });
    return { db, t, lead, staff, item };
  }

  it("counts each person's own day, as that person", async () => {
    const { db, t, lead, staff } = await scene();
    const since = new Date(NOW.getTime() - 86_400_000);
    // Clergy: 1 overdue; today's visit plus the journey's day-0 steps (clamped to the 24th, so overdue) ...
    const clergy = await computeSummary(db, t.clergy, "2026-11-25", since);
    expect(clergy).toEqual({ overdue: 3, dueToday: 1, inbox: 1, newSteps: 9 });
    expect(await computeSummary(db, lead, "2026-11-25", since)).toEqual({ overdue: 2, dueToday: 0, inbox: 0, newSteps: 4 });
    expect(await computeSummary(db, t.clergy2, "2026-11-25", since)).toEqual({ overdue: 0, dueToday: 0, inbox: 1, newSteps: 0 });
    expect(await computeSummary(db, staff, "2026-11-25", since)).toEqual({ overdue: 0, dueToday: 0, inbox: 0, newSteps: 0 });
    expect(await computeSummary(db, t.carer, "2026-11-25", since)).toEqual({ overdue: 0, dueToday: 0, inbox: 0, newSteps: 0 });
  });

  it("stores counts only for people who want it and have something; nothing on an empty day; nothing is sent", async () => {
    const { db, t, lead } = await scene();
    const email = vi.fn(async () => "not_configured" as const);
    const push = vi.fn(async () => "not_configured" as const);
    await setSummaryPref(db, t.clergy2, "none");
    const tally = await runMorningSummaries(db, NOW, OWNERS, "https://care.example.test", { email, push });
    const rows = await db.select().from(dailySummaries);
    // The owner has a new report to review; clergy2 chose none; the caregiver and staff default to none.
    expect(rows.map((r) => r.userId).sort()).toEqual([t.owner.id, t.clergy.id, lead.id].sort());
    expect(tally).toMatchObject({ stored: 3, sent: 0, emailNotConfigured: 3 });
    // Channels get the person's id and a message made of counts: never a name or a note.
    for (const [userId, message] of email.mock.calls as unknown as [string, { body: string }][]) {
      expect([t.owner.id, t.clergy.id, lead.id]).toContain(userId);
      expect(words(message)).not.toMatch(/Ruth|Cohen|frightened|bereavement|clergy@/i);
    }
    expect(push).not.toHaveBeenCalled();
    expect(await getMorningSummary(db, t.clergy, "2026-11-25")).toMatchObject({ overdue: 3 });
    expect(await getMorningSummary(db, t.clergy2, "2026-11-25")).toBeNull();
    expect(await getMorningSummary(db, t.clergy, "2026-11-26")).toBeNull();
  });

  it("summaryMessage holds counts and a link and nothing else", () => {
    const m = summaryMessage({ overdue: 2, dueToday: 1, inbox: 0, newSteps: 1 }, "https://care.example.test");
    expect(m.url).toBe("https://care.example.test/");
    expect(m.body).toContain("https://care.example.test/");
    // Only the numbers it was given, and no link but the app's own front page.
    expect(m.body.match(/\d+/g)).toEqual(["2", "1", "1"]);
    expect(m.body.replace(m.url, "")).not.toMatch(/https?:|@|\/people\//);
    expect(Object.keys(m).sort()).toEqual(["body", "title", "url"]);
  });

  it("delivery honours the preference, sends nothing on an empty day, and both channels report not configured", async () => {
    const summary = { overdue: 1, dueToday: 0, inbox: 0, newSteps: 0 };
    expect(await deliverSummary({ id: "u", pref: "both" }, summary, "https://x.test")).toEqual({ email: "not_configured", push: "not_configured" });
    expect(await deliverSummary({ id: "u", pref: "push" }, summary, "https://x.test")).toEqual({ email: "not_chosen", push: "not_configured" });
    expect(await deliverSummary({ id: "u", pref: "email" }, { ...summary, overdue: 0 }, "https://x.test")).toEqual({ email: "not_chosen", push: "not_chosen" });
    expect(await deliverSummary({ id: "u", pref: "none" }, summary, "https://x.test")).toEqual({ email: "not_chosen", push: "not_chosen" });
  });

  it("defaults to email for clergy and leads and none for others; each person changes only their own", async () => {
    const db = await testDb();
    const t = await team(db);
    const lead = await addActor(db, "lead@example.test", "lead");
    const staff = await addActor(db, "staff@example.test", "staff");
    expect([t.owner, t.clergy, lead, t.carer, staff].map((a) => effectivePref({ role: a.role, summaryPref: null }))).toEqual(["email", "email", "email", "none", "none"]);
    expect(await getSummaryPref(db, staff)).toEqual({ pref: "none", chosen: false });
    await setSummaryPref(db, staff, "both");
    expect(await getSummaryPref(db, staff)).toEqual({ pref: "both", chosen: true });
    await expect(setSummaryPref(db, staff, "sms")).rejects.toThrow();
    expect((await db.select().from(users).where(eq(users.id, t.clergy.id)))[0].summaryPref).toBeNull();
  });
});

describe("review round: retention edges and a failing recorder", () => {
  const closeAt = async (db: Db, id: string, at: Date) => db.update(careItems).set({ status: "closed", closedAt: at }).where(eq(careItems.id, id));
  const run = (db: Db, at: Date) => runDailyJob({ db, now: at, owners: OWNERS, origin: null });

  it("an item closed, reopened, rewritten and closed again keeps every word through each daily run, years on", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    await closeAt(db, item.id, new Date("2020-01-01T12:00:00Z"));
    await run(db, NOW);
    expect((await reopenCareItem(db, t.clergy, item.id)).summary).toBe(NOTE);
    await updateCareItem(db, t.clergy, item.id, { summary: "New worries" });
    await closeCareItem(db, t.clergy, item.id, NOW);
    for (const years of [3, 5, 10]) await run(db, new Date(NOW.getTime() + years * 366 * 86_400_000));
    const [row] = await db.select().from(careItems).where(eq(careItems.id, item.id));
    expect([row.summary, row.notesPurgedAt]).toEqual(["New worries", null]);
  });

  it("an item the retired purge once cleared is not cleared again: text written to it since stays", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness" });
    // As the old job left it: closed long ago, text gone, marked as cleared.
    await db.update(careItems).set({ status: "closed", closedAt: new Date("2020-01-01T12:00:00Z"), notesPurgedAt: new Date("2023-01-02T12:00:00Z") }).where(eq(careItems.id, item.id));
    // A closed item takes no new contact, but its own text can still be edited.
    await updateCareItem(db, t.clergy, item.id, { summary: "Written after the clearing" });
    await run(db, NOW);
    await run(db, new Date(NOW.getTime() + 5 * 366 * 86_400_000));
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0].summary).toBe("Written after the clearing");
  });

  it("items closed around a leap day (the old rule's edge) are kept on every date the old rule would have taken them", async () => {
    const db = await testDb();
    const t = await team(db);
    const a = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    const b = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam", category: "illness", summary: NOTE });
    const c = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    await closeAt(db, a.id, new Date("2025-03-01T06:00:00Z"));
    await closeAt(db, b.id, new Date("2025-02-28T06:00:00Z"));
    await closeAt(db, c.id, new Date("2024-02-29T06:00:00Z"));
    for (const at of ["2027-02-28T12:00:00Z", "2027-03-01T12:00:00Z", "2028-02-29T12:00:00Z", "2028-03-01T12:00:00Z"]) await run(db, new Date(at));
    expect((await db.select().from(careItems)).map((i) => i.summary)).toEqual([NOTE, NOTE, NOTE]);
  });

  it("an item whose 'keep' was switched off under the old rule is kept past the 30 days it was once given", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    await db.update(careItems).set({ status: "closed", closedAt: new Date("2020-01-01T12:00:00Z"), keepNotes: false, notesUnkeptAt: NOW }).where(eq(careItems.id, item.id));
    for (const days of [29, 30, 31, 400]) await run(db, new Date(NOW.getTime() + days * 86_400_000));
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0]).toMatchObject({ summary: NOTE, notesPurgedAt: null });
  });

  it("a job_runs recorder that fails stops nothing: later tasks still run", async () => {
    const db = await testDb();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const results = await runDailyJob({ db, now: NOW, owners: OWNERS, origin: null }, [
      {
        key: "breaks-the-recorder",
        run: async () => {
          await db.execute(sql`alter table job_runs rename to job_runs_gone`);
          throw new Error("x");
        },
      },
      { key: "after", run: async () => (ran.push("after"), { n: 1 }) },
    ]);
    expect(ran).toEqual(["after"]);
    expect(results.map((r) => [r.task, r.ok])).toEqual([
      ["breaks-the-recorder", false],
      ["after", true],
    ]);
  });
});

describe("the overdue check", () => {
  const at = (h: number) => new Date(Date.parse("2026-12-02T12:00:00Z") - h * 3_600_000);
  const now = new Date("2026-12-02T12:00:00Z");
  it("is overdue when nothing has run or the last success is over 26 hours old", () => {
    expect(jobIsOverdue([], now)).toBe(true);
    expect(jobIsOverdue([{ ok: true, startedAt: at(25), finishedAt: at(25) }], now)).toBe(false);
    expect(jobIsOverdue([{ ok: true, startedAt: at(27), finishedAt: at(27) }], now)).toBe(true);
    // A failed or unfinished run is not a success, however new.
    expect(jobIsOverdue([{ ok: false, startedAt: at(1), finishedAt: at(1) }, { ok: null, startedAt: at(1), finishedAt: null }], now)).toBe(true);
    expect(jobIsOverdue([{ ok: false, startedAt: at(1), finishedAt: at(1) }, { ok: true, startedAt: at(3), finishedAt: at(3) }], now)).toBe(false);
  });
});
