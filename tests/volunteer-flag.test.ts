import { eq } from "drizzle-orm";
import webpush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { getDismissedReport } from "@/server/care/original-reports";
import { dismissProposal, listInbox, listMyReports } from "@/server/care/proposals";
import { NotFound } from "@/server/care/validate";
import { auditLog, careItemAccess, emailLog, proposals, volunteerClaims, volunteerTasks } from "@/server/db/schema";
import { TOOLS } from "@/server/mcp/tools";
import { callTool } from "@/server/mcp/transport";
import { createVolunteerSeries } from "@/server/volunteers/series";
import type { Db } from "@/server/db/types";
import { noticeNewInbox, noticeUrgentProposal } from "@/server/notify/notify";
import { savePrefs } from "@/server/notify/prefs";
import { subscribeDevice } from "@/server/notify/subscriptions";
import { FLAG_LIMITS, flagForRabbis } from "@/server/volunteers/flag";
import { getCoordinatorHome } from "@/server/volunteers/home";
import { cancelVolunteerTask, createVolunteerTask, getVolunteerTask, removeClaim } from "@/server/volunteers/organiser";
import { cancelMyClaim, claimEveryTime, claimTask, markMyClaimDone, VOLUNTEER_LIMITS } from "@/server/volunteers/public";
import { purgeVolunteerData } from "@/server/volunteers/purge";
import { withinLimit } from "@/server/meals/rate-limit";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { meta, NOW } from "./support/meals";
import { words } from "./support/words";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));
const sendNotification = vi.mocked(webpush.sendNotification);
/** Work scheduled to run after the response (the reading and the phone notices), captured instead of run. */
const scheduled = vi.hoisted(() => [] as unknown[]);
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: (fn: unknown) => void scheduled.push(fn) }));

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
function stubPush() {
  vi.stubEnv("VAPID_PUBLIC_KEY", "BPublicKeyForTestsOnly");
  vi.stubEnv("VAPID_PRIVATE_KEY", "private-key-for-tests-only");
  vi.stubEnv("VAPID_SUBJECT", "mailto:care@example.test");
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
}
/** A phone for `actor` with every notice they may have switched on, quiet hours off. */
async function phone(actor: Actor) {
  await subscribeDevice(db, actor, { endpoint: `https://fcm.googleapis.com/fcm/send/${actor.id}`, ...KEYS, userAgent: "iPhone" });
  await savePrefs(db, actor, { kinds: { urgent_inbox: true, new_inbox: true, assigned: true, coordinator: true }, quietEnabled: false, quietStartHour: 21, quietEndHour: 7, urgentIgnoresQuiet: true });
}
const pushedTo = () => [...new Set(sendNotification.mock.calls.map(([sub]) => (sub as { endpoint: string }).endpoint.split("/").pop()))].sort();

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;

/** What the volunteer writes: a sensitive word in it, which must NOT be refused. */
const WORDS = "I think I am in over my head. She told me about her depression and the eviction notice.";
const SECRET = "Chemotherapy starts Monday";
const DAY = 86_400_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);

const taskInput = (over: Record<string, unknown> = {}) => ({ kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", timeWindow: "2 to 4 pm", place: "41 Elm Court", contactLine: "Ask Dana", ...over });

async function claimed(actor: Actor = t.lead, over: Record<string, unknown> = {}) {
  const task = await createVolunteerTask(db, actor, taskInput(over), NOW);
  const r = await claimTask(db, task.publicToken, { firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "", mayAskAgain: false }, meta(), NOW);
  if (!r.ok) throw new Error(r.reason);
  // The database stamps createdAt with the real clock; everything else here runs on the test's NOW.
  await db.update(volunteerClaims).set({ createdAt: NOW }).where(eq(volunteerClaims.id, r.claimId));
  return { task, token: r.manageToken, claimId: r.claimId };
}

const flag = (token: string, text: unknown = WORDS, now = NOW, m: unknown = meta()) => flagForRabbis(db, token, text, m, now);
const allProposals = () => db.select().from(proposals);

beforeEach(async () => {
  scheduled.length = 0;
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("who can send", () => {
  it("only a live personal link: unknown, cancelled, removed, cancelled task and purged links answer not found and make nothing", async () => {
    expect(await flag("no-such-token")).toEqual({ ok: false, reason: "not_found" });
    const a = await claimed();
    await cancelMyClaim(db, a.token, meta(), NOW);
    expect(await flag(a.token)).toEqual({ ok: false, reason: "not_found" });
    const b = await claimed(t.lead, { forLabel: "Dov" });
    await removeClaim(db, t.lead, b.claimId, false, NOW);
    expect(await flag(b.token)).toEqual({ ok: false, reason: "not_found" });
    const c = await claimed(t.lead, { forLabel: "Lea" });
    await cancelVolunteerTask(db, t.lead, c.task.id, NOW);
    expect(await flag(c.token)).toEqual({ ok: false, reason: "not_found" });
    const d = await claimed(t.lead, { forLabel: "Ben" });
    await purgeVolunteerData(db, later(120 * DAY));
    expect(await flag(d.token)).toEqual({ ok: false, reason: "not_found" });
    expect(await allProposals()).toEqual([]);
    const flagged = await db.select({ at: volunteerClaims.flaggedAt }).from(volunteerClaims);
    expect(flagged.every((r) => r.at === null)).toBe(true);
  });

  it("a claim that is done may still send: that is often when a volunteer knows", async () => {
    const a = await claimed();
    expect(await markMyClaimDone(db, a.token, "", meta(), NOW)).toEqual({ ok: true });
    expect(await flag(a.token)).toEqual({ ok: true });
  });

  it("an every-time link has no such box yet and is refused like a dead link", async () => {
    const s = await createVolunteerSeries(db, t.lead, { ...taskInput({ date: "2026-12-02" }), every: 1, weekdays: [3], count: 3 }, NOW);
    const [first] = await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, s.taskIds[0]));
    const r = await claimEveryTime(db, first.publicToken,{ firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "", mayAskAgain: false }, meta(), NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(await flag(r.manageToken)).toEqual({ ok: false, reason: "not_found" });
  });

  it("the honeypot, a form back too fast, and a missing client are refused", async () => {
    const a = await claimed();
    expect(await flag(a.token, WORDS, NOW, { ...meta(), honeypot: "http://spam.test" })).toEqual({ ok: false, reason: "refused" });
    expect(await flag(a.token, WORDS, NOW, { ...meta(), elapsedMs: 300 })).toEqual({ ok: false, reason: "refused" });
    expect(await flag(a.token, WORDS, NOW, { ...meta(), elapsedMs: null })).toEqual({ ok: false, reason: "refused" });
    expect(await flag(a.token, WORDS, NOW, null)).toEqual({ ok: false, reason: "invalid", fields: ["clientMeta"] });
    expect(await allProposals()).toEqual([]);
  });
});

describe("what is refused, and what is not", () => {
  it("refuses only emptiness, length and bad characters; a sensitive word is NOT refused", async () => {
    const a = await claimed();
    const invalid = { ok: false, reason: "invalid", fields: ["words"] };
    for (const bad of ["", "   \n  ", "x".repeat(1001), "Hello‮world", "Zero​width", "Bell\u0007", "Bare\rreturn", null, 42, ["a"]]) expect(await flag(a.token, bad)).toEqual(invalid);
    expect(await allProposals()).toEqual([]);
    expect(await flag(a.token, "x".repeat(1000))).toEqual({ ok: true });
    expect(await flag(a.token, "Line one\r\nLine two\n\tindented")).toEqual({ ok: true });
    expect(await flag(a.token, WORDS)).toEqual({ ok: true });
    const texts = (await allProposals()).map((p) => p.rawText ?? "");
    expect(texts.some((x) => x.endsWith("Line one\nLine two\n\tindented"))).toBe(true);
    expect(texts.some((x) => x.endsWith(WORDS))).toBe(true);
  });
});

describe("the proposal", () => {
  it("is an ordinary clergy proposal: no submitter, labelled as from a volunteer, channel form, never practical, with the context written by the server", async () => {
    const a = await claimed();
    expect(await flag(a.token)).toEqual({ ok: true });
    const [p] = await allProposals();
    expect(p).toMatchObject({ channel: "form", submittedBy: null, submitterLabel: "A volunteer", reviewScope: "clergy", status: "pending", practical: false, leadVisible: false, intake: null, resultCareItemId: null, mayTellThem: null });
    expect(p.rawText).toBe(`From a volunteer's own page.\nVolunteer: Sam\nTask: Visit for Ruth\nWhen: Saturday, December 5, 2 to 4 pm\n\nWhat they wrote:\n${WORDS}`);
    // Only what the volunteer gave: no last name, no contact.
    expect(p.rawText).not.toContain("Katz");
    expect(p.rawText).not.toContain("sam@example.test");
  });

  it("appears in the Inbox for clergy and for nobody else", async () => {
    const a = await claimed();
    await flag(a.token);
    for (const actor of [t.owner, t.clergy, t.clergy2]) {
      const inbox = await listInbox(db, actor);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ submitterName: "A volunteer", channel: "form" });
    }
    for (const actor of [t.carer, t.carer2, t.staff, t.lead, t.senior]) expect(await listInbox(db, actor)).toEqual([]);
  });

  it("on a task for a RESTRICTED care item, carries nothing of the item, and only those it is open to can review it", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET, restricted: true });
    const a = await claimed(t.clergy, { careItemId: item.id });
    expect(await flag(a.token)).toEqual({ ok: true });
    const [p] = await allProposals();
    expect(p).toMatchObject({ resultCareItemId: null, scopeCareItemId: item.id, submittedBy: null, submitterLabel: "A volunteer" });
    expect(words(p)).not.toMatch(/Cohen|illness|Chemotherapy/);

    // The item's owner reviews it, not as their own capture; the owner role and other clergy see nothing, anywhere.
    const [mine] = await listInbox(db, t.clergy);
    expect(mine).toMatchObject({ id: p.id, submitterName: "A volunteer" });
    for (const actor of [t.owner, t.clergy2]) {
      expect(await listInbox(db, actor)).toEqual([]);
      const viaConnector = await callTool(TOOLS.find((x) => x.name === "care_inbox")!, {}, { db, sf: () => ({ query: async () => [] }), now: NOW, actor });
      expect((viaConnector.structuredContent as { proposals: unknown[] }).proposals).toEqual([]);
      await expect(dismissProposal(db, actor, p.id)).rejects.toBeInstanceOf(NotFound);
    }
    expect(await listMyReports(db, t.clergy)).toEqual([]);
    // Named on the item: clergy2 now reviews it too, and can dismiss it; then only those it is open to read the kept words.
    await db.insert(careItemAccess).values({ careItemId: item.id, userId: t.clergy2.id });
    expect((await listInbox(db, t.clergy2)).map((x) => x.id)).toEqual([p.id]);
    await dismissProposal(db, t.clergy2, p.id);
    expect((await getDismissedReport(db, t.clergy, p.id)).words).toContain(WORDS);
    await expect(getDismissedReport(db, t.owner, p.id)).rejects.toBeInstanceOf(NotFound);

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "volunteer_claim.flag"));
    expect(JSON.stringify(audit)).not.toContain(item.id);
    // The lead cannot see the task, so learns nothing of the flag either.
    await expect(getVolunteerTask(db, t.lead, a.task.id, NOW)).rejects.toBeInstanceOf(NotFound);
    expect((await getCoordinatorHome(db, t.lead, later(60_000))).changes).toEqual([]);
  });

  it("on a RESTRICTED care item, the urgent and new-Inbox notices go only to those the item is open to", async () => {
    stubPush();
    for (const a of [t.owner, t.clergy, t.clergy2]) await phone(a);
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET, restricted: true });
    const a = await claimed(t.clergy, { careItemId: item.id });
    expect(await flag(a.token)).toEqual({ ok: true });
    const [p] = await allProposals();
    // createdAt is the database's clock; the notices run at the test's fixed NOW.
    await db.update(proposals).set({ reading: { summary: "Needs a call", urgency: "today" }, createdAt: NOW }).where(eq(proposals.id, p.id));
    expect(await noticeUrgentProposal(db, p.id, later(60_000))).toBe(1);
    expect(await noticeNewInbox(db, later(120_000))).toBe(1);
    expect(pushedTo()).toEqual([t.clergy.id]);
  });

  it("on an unrestricted care item, every clergy member reviews it as usual", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET });
    const a = await claimed(t.clergy, { careItemId: item.id });
    await flag(a.token);
    for (const actor of [t.owner, t.clergy, t.clergy2]) expect(await listInbox(db, actor)).toHaveLength(1);
  });
});

describe("limits", () => {
  it("3 a claim a day, then the calm refusal; the next day it is open again; failed sends do not count", async () => {
    const a = await claimed();
    expect(await flag(a.token, "")).toMatchObject({ reason: "invalid" });
    for (let i = 0; i < FLAG_LIMITS.perClaimPerDay; i++) expect(await flag(a.token, `${WORDS} ${i}`)).toEqual({ ok: true });
    expect(await flag(a.token)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await allProposals()).toHaveLength(FLAG_LIMITS.perClaimPerDay);
    // Another volunteer's link is not held up by this one.
    const b = await claimed(t.lead, { forLabel: "Dov" });
    expect(await flag(b.token)).toEqual({ ok: true });
    expect(await flag(a.token, WORDS, later(DAY))).toEqual({ ok: true });
  });

  it("shares the per-client cap of the other personal-link actions", async () => {
    const a = await claimed();
    const same = meta("198.51.100.250");
    for (let i = 0; i < VOLUNTEER_LIMITS.managePerClient; i++) await flagForRabbis(db, "no-such-token", WORDS, same, NOW);
    expect(await flagForRabbis(db, a.token, WORDS, same, NOW)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await allProposals()).toEqual([]);
  });

  it("past the hard ceiling of stored flags an hour, a flag is refused with the calm try-again answer", async () => {
    const a = await claimed();
    for (let i = 0; i < FLAG_LIMITS.storedPerHour - 1; i++) await withinLimit(db, "vol:flag:stored", FLAG_LIMITS.storedPerHour, NOW);
    expect(FLAG_LIMITS.storedPerHour).toBe(200);
    expect(await flag(a.token, `${WORDS} last`)).toEqual({ ok: true });
    expect(await flag(a.token)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await allProposals()).toHaveLength(1);
    expect(await flag(a.token, WORDS, later(3_600_000))).toEqual({ ok: true });
  });

  it("past the hour's cap for every link together, a flag is still kept but neither read nor announced", async () => {
    stubPush();
    const links = [];
    for (let i = 0; i < 11; i++) links.push(await claimed(t.lead, { forLabel: `Person ${i}` }));
    for (const l of links)
      for (let k = 0; k < 3; k++) {
        const before = scheduled.length;
        expect(await flag(l.token, `${WORDS} ${k}`)).toEqual({ ok: true });
        const n = (await allProposals()).length;
        // The first 30 schedule their notices after the response; the rest schedule nothing.
        expect(scheduled.length > before, `flag ${n}`).toBe(n <= FLAG_LIMITS.allPerHour);
      }
    expect(await allProposals()).toHaveLength(33);
    const flagged = await db.select({ at: volunteerClaims.flaggedAt }).from(volunteerClaims);
    expect(flagged.every((r) => r.at !== null)).toBe(true);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "volunteer_claim.flag"))).toHaveLength(33);
    // The next hour, announced again.
    const before = scheduled.length;
    expect(await flag(links[0].token, WORDS, later(DAY))).toEqual({ ok: true });
    expect(scheduled.length).toBeGreaterThan(before);
  });
});

describe("the poster and the coordinator learn only THAT", () => {
  it("the task shows when a flag was raised, the home feed says so with no name, and the words are nowhere in either", async () => {
    const poster = await claimed(t.clergy);
    expect(await flag(poster.token)).toEqual({ ok: true });
    for (const actor of [t.clergy, t.lead]) {
      const view = await getVolunteerTask(db, actor, poster.task.id, NOW);
      expect(view.claims[0].flaggedAt).toEqual(NOW);
      expect(words(view)).not.toContain("over my head");
      expect(words(view)).not.toContain("depression");
      const home = await getCoordinatorHome(db, actor, later(60_000));
      const change = home.changes.find((c) => c.kind === "flagged");
      expect(change).toMatchObject({ kind: "flagged", firstName: null, note: null, label: "Ruth" });
      expect(words(home)).not.toContain("over my head");
    }
  });

  it("the home feed orders by the newest event, so a fresh flag on an old claim is not cut off by newer claims", async () => {
    const old = await claimed(t.lead);
    // Over 100 newer claims, each on its own task, all inside the feed's window.
    for (let i = 0; i < 101; i++) {
      const task = await createVolunteerTask(db, t.lead, taskInput({ forLabel: `Person ${i}` }), NOW);
      const r = await claimTask(db, task.publicToken, { firstName: "Ann", lastName: "Lee", contact: `ann${i}@example.test`, note: "", mayAskAgain: false }, meta(), later(1_000 + i));
      if (!r.ok) throw new Error(r.reason);
      await db.update(volunteerClaims).set({ createdAt: later(1_000 + i) }).where(eq(volunteerClaims.id, r.claimId));
    }
    expect(await flag(old.token, WORDS, later(3_600_000))).toEqual({ ok: true });
    const home = await getCoordinatorHome(db, t.lead, later(3_700_000));
    expect(home.changes.some((c) => c.kind === "flagged" && c.label === "Ruth")).toBe(true);
  });
});

describe("the words go only to the proposal", () => {
  it("no audit row, log line, email or push notice holds them", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPublicKeyForTestsOnly");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private-key-for-tests-only");
    vi.stubEnv("VAPID_SUBJECT", "mailto:care@example.test");
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    await subscribeDevice(db, t.clergy, { endpoint: `https://fcm.googleapis.com/fcm/send/${t.clergy.id}`, ...keys, userAgent: "iPhone" });
    await savePrefs(db, t.clergy, { kinds: { urgent_inbox: true, new_inbox: true, assigned: true, coordinator: true }, quietEnabled: false, quietStartHour: 21, quietEndHour: 7, urgentIgnoresQuiet: true });
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));

    const a = await claimed();
    expect(await flag(a.token)).toEqual({ ok: true });
    const [p] = await allProposals();
    // As if the reading said "today": the urgent notice, then the new-arrival notice.
    await db.update(proposals).set({ reading: { summary: "Needs a call", urgency: "today" }, createdAt: NOW }).where(eq(proposals.id, p.id));
    expect(await noticeUrgentProposal(db, p.id, later(60_000))).toBe(1);
    expect(await noticeNewInbox(db, later(120_000))).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "volunteer_claim.flag"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ subjectType: "volunteer_claim", subjectId: a.claimId, actorUserId: null, detail: { by: "volunteer", volunteerTaskId: a.task.id } });
    const everywhere = words({ audit: await db.select().from(auditLog), emails: await db.select().from(emailLog), pushes: sendNotification.mock.calls, logged, claims: await db.select().from(volunteerClaims) });
    for (const piece of ["over my head", "depression", "eviction"]) expect(everywhere).not.toContain(piece);
    expect(await db.select().from(emailLog)).toEqual([]);
  });
});
