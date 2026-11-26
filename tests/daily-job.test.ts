import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { createCareItem, setKeepNotes } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp, setFollowUpDone } from "@/server/care/follow-ups";
import { createProposal } from "@/server/care/proposals";
import { NotFound } from "@/server/care/validate";
import { auditLog, captureTokens, careItems, contactLog, dailySummaries, followUps, jobRuns, mealRateLimits, proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { pruneRateLimits, revokeIdleCaptureTokens, countDecidedWithWords } from "@/server/daily/housekeeping";
import { handleDailyRequest, isScheduledCall } from "@/server/daily/request";
import { notesDeleteOn, purgeOldNotes, PURGED_TITLE } from "@/server/daily/retention";
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

describe("note retention", () => {
  const YEAR3 = (days: number) => new Date(NOW.getTime() - (3 * 365 + days) * 86_400_000);
  async function closedItem(db: Db, t: Awaited<ReturnType<typeof team>>, closedAt: Date, extra: Partial<typeof careItems.$inferInsert> = {}, contact = CONTACT) {
    const item = await createCareItem(db, t.clergy, { sfContactId: contact, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: NOTE, location: "Barnes, room 4", learnedFrom: "Her daughter" });
    await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "call", occurredAt: new Date("2023-01-01T12:00:00Z"), note: NOTE });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Ask about the scan", dueDate: "2023-01-05" });
    await db.update(careItems).set({ status: "closed", closedAt, ...extra }).where(eq(careItems.id, item.id));
    return item;
  }

  it("clears note text three years after closing, keeps rows and dates, and audits ids only; one day short is left alone", async () => {
    const db = await testDb();
    const t = await team(db);
    // 3 years plus a day ago (allowing for the leap day in the span), and 2 years 364 days ago.
    const due = await closedItem(db, t, YEAR3(2));
    const notYet = await closedItem(db, t, YEAR3(-1), {}, CONTACT2);
    expect(await purgeOldNotes(db, NOW)).toEqual({ items: 1, contacts: 1, followUps: 1 });

    const [a] = await db.select().from(careItems).where(eq(careItems.id, due.id));
    expect([a.summary, a.location, a.learnedFrom, a.status, a.closedAt?.getTime(), a.notesPurgedAt]).toEqual([null, null, null, "closed", YEAR3(2).getTime(), NOW]);
    const [c] = await db.select().from(contactLog).where(eq(contactLog.careItemId, due.id));
    expect([c.note, c.kind, c.occurredAt.toISOString()]).toEqual([null, "call", "2023-01-01T12:00:00.000Z"]);
    const [f] = await db.select().from(followUps).where(eq(followUps.careItemId, due.id));
    expect([f.title, f.dueDate]).toEqual([PURGED_TITLE, "2023-01-05"]);

    const [b] = await db.select().from(careItems).where(eq(careItems.id, notYet.id));
    expect(b.summary).toBe(NOTE);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "care_item.notes_purged"));
    expect(audit.map((r) => [r.actorUserId, r.subjectId, r.detail])).toEqual([[null, due.id, { careItemId: due.id, by: "system" }]]);
    // Run again: nothing more.
    expect(await purgeOldNotes(db, NOW)).toEqual({ items: 0, contacts: 0, followUps: 0 });
  });

  it("also clears journey steps: an edited step title and a lead's outcome line are gone after the purge", async () => {
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
    await db.update(careItems).set({ status: "closed", closedAt: YEAR3(10) }).where(eq(careItems.id, item.id));
    await purgeOldNotes(db, NOW);
    const after = await db.select().from(followUps).where(eq(followUps.careItemId, item.id));
    expect(after).toHaveLength(journeySteps.length);
    expect(new Set(after.map((f) => f.title))).toEqual(new Set([PURGED_TITLE]));
    expect(after.every((f) => f.outcomeNote === null)).toBe(true);
    expect(words(after)).not.toMatch(/chemo|cried/);
    // Dates and the done mark stay.
    expect(after.find((f) => f.id === leadStep.id)?.doneAt).toEqual(new Date("2023-01-03T12:00:00Z"));
  });

  it("never touches an item marked keep, or one that is open, new or paused; a restricted item is cleared like any other, without anyone reading it", async () => {
    const db = await testDb();
    const t = await team(db);
    const old = YEAR3(30);
    const kept = await closedItem(db, t, old, { keepNotes: true });
    const open = await closedItem(db, t, old, { status: "open" });
    const fresh = await closedItem(db, t, old, { status: "new" });
    const paused = await closedItem(db, t, old, { status: "paused", pausedUntil: "2027-01-01" });
    const restricted = await closedItem(db, t, old, { restricted: true }, CONTACT2);
    const result = await purgeOldNotes(db, NOW);
    expect(result).toEqual({ items: 1, contacts: 1, followUps: 1 });
    const rows = await db.select({ id: careItems.id, summary: careItems.summary }).from(careItems);
    const summary = (id: string) => rows.find((r) => r.id === id)!.summary;
    expect([kept, open, fresh, paused].map((i) => summary(i.id))).toEqual([NOTE, NOTE, NOTE, NOTE]);
    expect(summary(restricted.id)).toBeNull();
    // Nothing of the restricted item was recorded as read by anyone.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "restricted.view"))).toEqual([]);
  });

  it("'Keep these notes': clergy who fully see the item set it, it is audited, and the delete date says so", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await closedItem(db, t, new Date("2026-01-10T12:00:00Z"));
    const [row] = await db.select().from(careItems).where(eq(careItems.id, item.id));
    expect(notesDeleteOn(row)?.toISOString()).toBe("2029-01-10T12:00:00.000Z");
    await expect(setKeepNotes(db, t.carer, item.id, true)).rejects.toBeInstanceOf(NotFound);
    const restricted = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam", category: "illness", restricted: true });
    await expect(setKeepNotes(db, t.owner, restricted.id, true)).rejects.toBeInstanceOf(NotFound);
    const kept = await setKeepNotes(db, t.clergy2, item.id, true);
    expect(notesDeleteOn(kept)).toBeNull();
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "care_item.keep_notes"));
    expect(audit.map((a) => [a.actorUserId, a.subjectId, a.detail])).toEqual([[t.clergy2.id, item.id, { keepNotes: true }]]);
  });
});

describe("housekeeping", () => {
  it("revokes capture keys unused for 180 days, deletes expired rate-limit rows, and only counts decided proposals that still hold words", async () => {
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

    await createProposal(db, t.clergy, { rawText: NOTE, channel: "capture" });
    expect(await countDecidedWithWords(db)).toBe(0);
    await db.update(proposals).set({ status: "dismissed" });
    expect(await countDecidedWithWords(db)).toBe(1);
    // Counted, not changed.
    expect((await db.select().from(proposals))[0].rawText).toBe(NOTE);
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

  it("a reopened item is no longer 'cleared': new text after reopening is purged again three years after the next close", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    await closeAt(db, item.id, new Date("2020-01-01T12:00:00Z"));
    expect((await purgeOldNotes(db, NOW)).items).toBe(1);
    const { reopenCareItem, closeCareItem, updateCareItem } = await import("@/server/care/care-items");
    expect((await reopenCareItem(db, t.clergy, item.id)).notesPurgedAt).toBeNull();
    await updateCareItem(db, t.clergy, item.id, { summary: "New worries" });
    await closeCareItem(db, t.clergy, item.id, NOW);
    const later = new Date(NOW.getTime() + 3 * 366 * 86_400_000);
    expect((await purgeOldNotes(db, NOW)).items).toBe(0);
    expect((await purgeOldNotes(db, later)).items).toBe(1);
    const [row] = await db.select().from(careItems).where(eq(careItems.id, item.id));
    expect(row.summary).toBeNull();
  });

  it("a note written to a cleared item (still closed) takes the cleared mark off", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    await closeAt(db, item.id, new Date("2020-01-01T12:00:00Z"));
    await purgeOldNotes(db, NOW);
    // A closed item takes no new contact, but its own text can still be edited.
    const { updateCareItem } = await import("@/server/care/care-items");
    await updateCareItem(db, t.clergy, item.id, { summary: "Written after the clearing" });
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0].notesPurgedAt).toBeNull();
    // Closed more than three years ago, so the next run clears the new text too.
    expect((await purgeOldNotes(db, NOW)).items).toBe(1);
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0].summary).toBeNull();
  });

  it("an item closed on 29 February is never purged a day early", async () => {
    const db = await testDb();
    const t = await team(db);
    const a = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    const b = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam", category: "illness", summary: NOTE });
    // Closed 1 March 2025 and 28 February 2025; the run is on 29 February 2028.
    await closeAt(db, a.id, new Date("2025-03-01T06:00:00Z"));
    await closeAt(db, b.id, new Date("2025-02-28T06:00:00Z"));
    expect((await purgeOldNotes(db, new Date("2028-02-29T12:00:00Z"))).items).toBe(1);
    expect((await db.select().from(careItems).where(eq(careItems.id, a.id)))[0].summary).toBe(NOTE);
    // Closed on 29 February 2024: due 1 March 2027, not 28 February.
    const c = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    await closeAt(db, c.id, new Date("2024-02-29T06:00:00Z"));
    expect((await purgeOldNotes(db, new Date("2027-02-28T12:00:00Z"))).items).toBe(0);
    const [row] = await db.select().from(careItems).where(eq(careItems.id, c.id));
    expect(notesDeleteOn(row)?.toISOString()).toBe("2027-03-01T06:00:00.000Z");
    expect((await purgeOldNotes(db, new Date("2027-03-01T12:00:00Z"))).items).toBe(1);
  });

  it("switching 'keep' off past the three years gives 30 days before the notes go, and the item says when", async () => {
    const db = await testDb();
    const t = await team(db);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", category: "illness", summary: NOTE });
    await closeAt(db, item.id, new Date("2020-01-01T12:00:00Z"));
    await setKeepNotes(db, t.clergy, item.id, true, NOW);
    expect((await purgeOldNotes(db, NOW)).items).toBe(0);
    const unkept = await setKeepNotes(db, t.clergy, item.id, false, NOW);
    expect(notesDeleteOn(unkept)?.toISOString()).toBe(new Date(NOW.getTime() + 30 * 86_400_000).toISOString());
    expect((await purgeOldNotes(db, new Date(NOW.getTime() + 29 * 86_400_000))).items).toBe(0);
    expect((await purgeOldNotes(db, new Date(NOW.getTime() + 30 * 86_400_000))).items).toBe(1);
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
