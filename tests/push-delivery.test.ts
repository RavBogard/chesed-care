import { eq, sql } from "drizzle-orm";
import webpush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderNotice } from "@/lib/notice";
import { type Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { createSalesforceProposal } from "@/server/care/intake";
import { createProposal } from "@/server/care/proposals";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { DAILY_TASKS } from "@/server/daily/run";
import { deliverSummary, NOT_CONFIGURED, runMorningSummaries, setSummaryPref, summaryMessage } from "@/server/daily/summary";
import { auditLog, followUps, notificationHeld, notificationLog, notificationPrefs, proposals, pushSubscriptions } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { flushHeld, noticeAssigned, noticeNewInbox, noticePlaceOpened, noticeReferral, noticeUnfilledAsks, noticeUrgentByKey, noticeUrgentProposal, purgeNotificationLog } from "@/server/notify/notify";
import { savePrefs } from "@/server/notify/prefs";
import { sendPush } from "@/server/notify/send";
import { MAX_DEVICES, listDevices, purgeRevoked, removeDevice, removeDeviceByEndpoint, subscribeDevice } from "@/server/notify/subscriptions";
import { pushSummaryChannel } from "@/server/notify/summary-channel";
import { sendTestNotice } from "@/server/notify/test-send";
import { signUpForMeal, cancelMySignup } from "@/server/meals/public";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { cancelMyClaim, claimTask } from "@/server/volunteers/public";
import { createReferral, setReferralConsent, withdrawReferral } from "@/server/volunteers/referrals";
import { fakeSf } from "./support/sf";
import { ACCOUNT, addActor, CONTACT, reporters, team, testDb } from "./support/db";
import { helper, livePage, meta, NOW } from "./support/meals";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));
const sendNotification = vi.mocked(webpush.sendNotification);

const OWNERS: ReadonlySet<string> = new Set(["owner@example.test"]);
const T0 = NOW; // 12:00 in St. Louis, Tuesday 1 December 2026
const NIGHT = new Date("2026-12-02T04:00:00Z"); // 10 pm
const JOB = new Date("2026-12-02T12:00:00Z"); // 6 am, when the daily job runs
const MIN = 60_000;
const HOUR = 3_600_000;
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MIN);
const PUSH_ENV = { VAPID_PUBLIC_KEY: "BPublicKeyForTestsOnly", VAPID_PRIVATE_KEY: "private-key-for-tests-only", VAPID_SUBJECT: "mailto:care@example.test" };
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;

const endpointOf = (actor: Actor, n = 1) => `https://fcm.googleapis.com/fcm/send/${actor.id}-${n}`;
const device = (actor: Actor, n = 1, userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)") => subscribeDevice(db, actor, { endpoint: endpointOf(actor, n), ...KEYS, userAgent });
/** Every call to the (mocked) push service: who it went to, and the payload and options. */
const calls = () => sendNotification.mock.calls.map(([sub, payload, options]) => ({ endpoint: (sub as { endpoint: string }).endpoint, payload: JSON.parse(payload as string) as { kind: string; count?: number; path: string }, options: options as Record<string, unknown> }));
const sentTo = (actor: Actor) => calls().filter((c) => c.endpoint.includes(actor.id));
const recipients = () => [...new Set(calls().map((c) => c.endpoint.split("/").pop()!.replace(/-\d+$/, "")))].sort();
const ids = (...actors: Actor[]) => actors.map((a) => a.id).sort();
const choose = (actor: Actor, kinds: Partial<Record<string, boolean>>, over: Record<string, unknown> = {}) =>
  savePrefs(db, actor, { kinds: { urgent_inbox: false, new_inbox: false, assigned: false, coordinator: false, ...kinds }, quietEnabled: true, quietStartHour: 21, quietEndHour: 7, urgentIgnoresQuiet: true, ...over });

async function arrive(by: Actor, over: { reading?: unknown; scope?: "submitter" | "clergy"; createdAt?: Date } = {}) {
  const made = await createProposal(db, by, { rawText: "A short report", channel: "staff", reading: over.reading, reviewScope: over.scope });
  if (over.createdAt) await db.update(proposals).set({ createdAt: over.createdAt }).where(eq(proposals.id, made.id));
  return made;
}
const renderBody = (p: { kind: string; count?: number }) => renderNotice(p as Parameters<typeof renderNotice>[0]).body;
const TODAY_READING = { summary: "Needs a call", urgency: "today" };

beforeEach(async () => {
  for (const [k, v] of Object.entries(PUSH_ENV)) vi.stubEnv(k, v);
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("devices", () => {
  it("a person turns a device on, sees it with a broad label, and never sees the endpoint or keys", async () => {
    const made = await device(t.clergy);
    expect(made.deviceLabel).toBe("iPhone");
    const list = await listDevices(db, t.clergy);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "deviceLabel", "id", "lastSuccessAt"]);
    expect(JSON.stringify(list)).not.toMatch(/fcm|p256dh|BNcRdre/);
  });

  it("refuses a seventh device, but the same browser can subscribe again", async () => {
    for (let n = 1; n <= MAX_DEVICES; n++) await device(t.clergy, n);
    await expect(device(t.clergy, MAX_DEVICES + 1)).rejects.toBeInstanceOf(InvalidInput);
    await expect(device(t.clergy, 1)).resolves.toBeTruthy();
    expect(await listDevices(db, t.clergy)).toHaveLength(MAX_DEVICES);
    // Another person's devices do not count against this person.
    await expect(device(t.clergy2, 1)).resolves.toBeTruthy();
    // A turned-off device frees a place.
    const [first] = await listDevices(db, t.clergy);
    await removeDevice(db, t.clergy, first.id);
    await expect(device(t.clergy, MAX_DEVICES + 1)).resolves.toBeTruthy();
  });

  it("refuses an address that is not a browser's push service, and badly formed keys", async () => {
    await expect(subscribeDevice(db, t.clergy, { endpoint: "https://evil.example/x", ...KEYS })).rejects.toBeInstanceOf(InvalidInput);
    await expect(subscribeDevice(db, t.clergy, { endpoint: endpointOf(t.clergy), p256dh: "not base64 !!", auth: KEYS.auth })).rejects.toBeInstanceOf(InvalidInput);
    await expect(subscribeDevice(db, t.clergy, { endpoint: endpointOf(t.clergy), p256dh: KEYS.p256dh, auth: 5 })).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  it("turning off, listing and testing act on the signed-in person's own devices only", async () => {
    await device(t.clergy);
    await device(t.clergy2);
    const [mine] = await listDevices(db, t.clergy);
    const [theirs] = await listDevices(db, t.clergy2);
    await expect(removeDevice(db, t.clergy, theirs.id)).rejects.toBeInstanceOf(NotFound);
    await expect(removeDevice(db, t.clergy, "not-an-id")).rejects.toBeInstanceOf(NotFound);
    await removeDeviceByEndpoint(db, t.clergy, endpointOf(t.clergy2));
    expect(await listDevices(db, t.clergy2)).toHaveLength(1);
    // An address on someone else's device is never moved to another person: it fails plainly.
    await device(t.clergy);
    await expect(subscribeDevice(db, t.clergy2, { endpoint: endpointOf(t.clergy), ...KEYS })).rejects.toBeInstanceOf(InvalidInput);
    expect(await listDevices(db, t.clergy)).toHaveLength(1);
    expect(await listDevices(db, t.clergy2)).toHaveLength(1);
    // Once that person has turned it off, the address is free.
    const [again] = await listDevices(db, t.clergy);
    await removeDevice(db, t.clergy, again.id);
    await subscribeDevice(db, t.clergy2, { endpoint: endpointOf(t.clergy), ...KEYS });
    expect(await listDevices(db, t.clergy2)).toHaveLength(2);
    // The test notice goes to the actor's devices and nobody else's.
    sendNotification.mockClear();
    expect(await sendTestNotice(db, t.clergy2)).toBe("sent");
    const own = (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, t.clergy2.id))).map((r) => r.endpoint).sort();
    expect(calls().map((c) => c.endpoint).sort()).toEqual(own);
    expect(mine.id).not.toBe(theirs.id);
  });

  it("a test with no device, and a test when not configured, say so and send nothing", async () => {
    expect(await sendTestNotice(db, t.carer)).toBe("no_device");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(await sendTestNotice(db, t.carer)).toBe("not_configured");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("the daily job deletes subscriptions revoked more than 30 days ago, and no others", async () => {
    for (const n of [1, 2, 3]) await device(t.clergy, n);
    const rows = await db.select().from(pushSubscriptions).orderBy(pushSubscriptions.endpoint);
    await db.update(pushSubscriptions).set({ revokedAt: new Date(NOW.getTime() - 31 * 24 * HOUR) }).where(eq(pushSubscriptions.id, rows[0].id));
    await db.update(pushSubscriptions).set({ revokedAt: new Date(NOW.getTime() - 5 * 24 * HOUR) }).where(eq(pushSubscriptions.id, rows[1].id));
    expect(await purgeRevoked(db, NOW)).toBe(1);
    expect((await db.select().from(pushSubscriptions)).map((r) => r.id).sort()).toEqual([rows[1].id, rows[2].id].sort());
  });
});

describe("device keys, the cap under load, and the audit trail", () => {
  it("accepts only a 87-character p256dh and a 22-character auth", async () => {
    const bad = [
      { p256dh: KEYS.p256dh.slice(1), auth: KEYS.auth },
      { p256dh: KEYS.p256dh + "A", auth: KEYS.auth },
      { p256dh: KEYS.p256dh, auth: KEYS.auth.slice(1) },
      { p256dh: KEYS.p256dh, auth: KEYS.auth + "A" },
      { p256dh: KEYS.p256dh.replace(/.$/, "="), auth: KEYS.auth },
    ];
    for (const keys of bad) await expect(subscribeDevice(db, t.clergy, { endpoint: endpointOf(t.clergy), ...keys })).rejects.toBeInstanceOf(InvalidInput);
    await expect(device(t.clergy)).resolves.toBeTruthy();
  });

  it("the cap holds when several devices are added at once", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => device(t.clergy, n)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_DEVICES);
    expect(await listDevices(db, t.clergy)).toHaveLength(MAX_DEVICES);
  });

  it("writes an audit row (ids only) when a device is turned on or off", async () => {
    const made = await device(t.clergy);
    await device(t.clergy); // the same browser again: not a new device
    await removeDevice(db, t.clergy, made.id);
    await device(t.clergy, 2);
    await removeDeviceByEndpoint(db, t.clergy, endpointOf(t.clergy, 2));
    const rows = await db.select().from(auditLog).orderBy(auditLog.at);
    expect(rows.map((r) => r.action)).toEqual(["push_device.add", "push_device.remove", "push_device.add", "push_device.remove"]);
    expect(rows.every((r) => r.subjectType === "push_device" && r.actorUserId === t.clergy.id && r.detail === null)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/fcm|BNcRdre|tBHItJ/);
  });
});

describe("sending", () => {
  it("sends to a person's devices all at once", async () => {
    for (const n of [1, 2, 3]) await device(t.clergy, n);
    // Every device waits until all three have been started: one after another would never finish.
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    sendNotification.mockImplementation(async (sub) => {
      started.push((sub as { endpoint: string }).endpoint);
      if (started.length === 3) release();
      await gate;
      return { statusCode: 201, body: "", headers: {} };
    });
    const result = await sendPush(db, t.clergy.id, { kind: "assigned" }, T0);
    expect(started).toHaveLength(3);
    expect(result).toMatchObject({ sent: 3, failed: 0 });
  });

  it("is 'not configured' everywhere when any variable is missing: nothing sent, nothing recorded", async () => {
    await device(t.clergy);
    vi.stubEnv("VAPID_SUBJECT", "");
    expect(await sendPush(db, t.clergy.id, { kind: "assigned" })).toEqual({ status: "not_configured" });
    const p = await arrive(t.staff, { reading: TODAY_READING });
    expect(await noticeUrgentProposal(db, p.id, T0, OWNERS)).toBe(0);
    expect(await noticeNewInbox(db, T0, OWNERS)).toBe(0);
    expect(await noticeAssigned(db, { toUserId: t.clergy.id, byUserId: t.clergy2.id, careItemId: (await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "A", category: "illness" })).id }, T0, OWNERS)).toBe(false);
    expect(await noticeUnfilledAsks(db, T0, OWNERS)).toEqual({ people: 0, sent: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await db.select().from(notificationLog)).toEqual([]);
  });

  it("sends only kind, count and path; high urgency for the urgent kind alone; a time to live and a tag per kind", async () => {
    await device(t.clergy);
    await sendPush(db, t.clergy.id, { kind: "urgent_inbox" }, T0);
    await sendPush(db, t.clergy.id, { kind: "new_inbox", count: 3 }, T0);
    await sendPush(db, t.clergy.id, { kind: "assigned", name: "Ruth Cohen", body: "free" } as never, T0);
    const [urgent, inbox, assigned] = calls();
    expect(urgent.payload).toEqual({ kind: "urgent_inbox", path: "/inbox" });
    expect(inbox.payload).toEqual({ kind: "new_inbox", count: 3, path: "/inbox" });
    expect(assigned.payload).toEqual({ kind: "assigned", path: "/" });
    expect(urgent.options).toMatchObject({ urgency: "high", TTL: 4 * 3600, topic: "urgent_inbox" });
    expect(inbox.options).toMatchObject({ urgency: "normal", TTL: 6 * 3600, topic: "new_inbox" });
    expect(calls().filter((c) => c.options.urgency === "high")).toHaveLength(1);
    expect(urgent.options.vapidDetails).toMatchObject({ subject: PUSH_ENV.VAPID_SUBJECT });
  });

  it("a 404 or 410 revokes that device at once; the person's other devices still get it", async () => {
    await device(t.clergy, 1);
    await device(t.clergy, 2);
    await device(t.clergy, 3);
    sendNotification.mockImplementation(async (sub) => {
      const e = (sub as { endpoint: string }).endpoint;
      if (e.endsWith("-1")) throw Object.assign(new Error("gone"), { name: "WebPushError", statusCode: 410 });
      if (e.endsWith("-2")) throw Object.assign(new Error("missing"), { name: "WebPushError", statusCode: 404 });
      return { statusCode: 201, body: "", headers: {} };
    });
    expect(await sendPush(db, t.clergy.id, { kind: "assigned" }, T0)).toMatchObject({ status: "done", devices: 3, sent: 1, revoked: 2, failed: 0 });
    expect(await listDevices(db, t.clergy)).toHaveLength(1);
  });

  it("other failures count, a success starts the count again, and five in a row revoke", async () => {
    await device(t.clergy);
    const fail = () => sendNotification.mockRejectedValueOnce(Object.assign(new Error("slow"), { name: "WebPushError", statusCode: 503 }));
    const state = async () => (await db.select().from(pushSubscriptions))[0];
    for (let i = 0; i < 4; i++) {
      fail();
      await sendPush(db, t.clergy.id, { kind: "assigned" }, T0);
    }
    expect(await state()).toMatchObject({ failureCount: 4, revokedAt: null });
    await sendPush(db, t.clergy.id, { kind: "assigned" }, T0); // succeeds
    expect(await state()).toMatchObject({ failureCount: 0, revokedAt: null, lastSuccessAt: T0 });
    for (let i = 0; i < 5; i++) {
      fail();
      await sendPush(db, t.clergy.id, { kind: "assigned" }, T0);
    }
    expect((await state()).revokedAt).toEqual(T0);
    // A revoked device is not tried again.
    sendNotification.mockClear();
    await sendPush(db, t.clergy.id, { kind: "assigned" }, T0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("logs nothing at all on success, and on failure only a fixed label and the error's name", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await device(t.clergy);
    await sendPush(db, t.clergy.id, { kind: "urgent_inbox" }, T0);
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
    sendNotification.mockRejectedValueOnce(Object.assign(new Error(`Received unexpected response code for ${endpointOf(t.clergy)} ${KEYS.auth}`), { name: "WebPushError", statusCode: 500, body: "payload", endpoint: endpointOf(t.clergy) }));
    await sendPush(db, t.clergy.id, { kind: "urgent_inbox" }, T0);
    const logged = spies.flatMap((s) => s.mock.calls);
    expect(logged).toEqual([["push.send_failed", "WebPushError"]]);
    expect(JSON.stringify(logged)).not.toMatch(/fcm|p256dh|BNcRdre|tBHItJ|payload/);
  });
});

describe("the urgent Inbox kind", () => {
  beforeEach(async () => {
    for (const a of [t.owner, t.clergy, t.clergy2, t.carer, t.staff, t.lead, t.senior]) await device(a);
  });

  it("goes to clergy and owner who may review it, by default, and to nobody else: once per proposal per person", async () => {
    const p = await arrive(t.staff, { reading: TODAY_READING });
    expect(await noticeUrgentProposal(db, p.id, T0, OWNERS)).toBe(3);
    expect(recipients()).toEqual(ids(t.owner, t.clergy, t.clergy2));
    expect(calls().every((c) => c.payload.kind === "urgent_inbox" && c.options.urgency === "high")).toBe(true);
    // The reading landing again, or a retry, sends nothing more.
    sendNotification.mockClear();
    expect(await noticeUrgentProposal(db, p.id, at(T0, 5), OWNERS)).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("is not sent for a reading that is not 'today', or once the proposal is decided", async () => {
    const week = await arrive(t.staff, { reading: { summary: "x", urgency: "week" } });
    const none = await arrive(t.staff);
    expect(await noticeUrgentProposal(db, week.id, T0, OWNERS)).toBe(0);
    expect(await noticeUrgentProposal(db, none.id, T0, OWNERS)).toBe(0);
    const done = await arrive(t.staff, { reading: TODAY_READING });
    await db.update(proposals).set({ status: "dismissed" }).where(eq(proposals.id, done.id));
    expect(await noticeUrgentProposal(db, done.id, T0, OWNERS)).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("a clergy member shut out of a proposal (a private capture) gets nothing about it", async () => {
    const mine = await arrive(t.clergy, { reading: TODAY_READING, scope: "submitter" });
    expect(await noticeUrgentProposal(db, mine.id, T0, OWNERS)).toBe(1);
    expect(recipients()).toEqual(ids(t.clergy));
    // Released to the shared Inbox it is theirs to see, and so is notified (a different proposal id key is not needed: it is once per person).
    sendNotification.mockClear();
    await db.update(proposals).set({ reviewScope: "clergy" }).where(eq(proposals.id, mine.id));
    expect(await noticeUrgentProposal(db, mine.id, at(T0, 1), OWNERS)).toBe(2);
    expect(recipients()).toEqual(ids(t.owner, t.clergy2));
  });

  it("a Salesforce death is urgent with no reading; a birth is not; the switch can be turned off", async () => {
    await createSalesforceProposal(db, { externalKey: "sf:death:1", rawText: "Start the bereavement year?", intake: { kind: "salesforce", event: "death", subjectId: CONTACT, accountId: null, household: null } });
    await createSalesforceProposal(db, { externalKey: "sf:birth:1", rawText: "A baby was born", intake: { kind: "salesforce", event: "birth", subjectId: CONTACT, accountId: null, household: null } });
    await choose(t.clergy2, { urgent_inbox: false });
    expect(await noticeUrgentByKey(db, "sf:birth:1", T0, OWNERS)).toBe(0);
    expect(await noticeUrgentByKey(db, "sf:death:1", T0, OWNERS)).toBe(2);
    expect(recipients()).toEqual(ids(t.owner, t.clergy));
    expect(await noticeUrgentByKey(db, "sf:missing", T0, OWNERS)).toBe(0);
  });

  it("is held in quiet hours only if the person turned 'let urgent through' off", async () => {
    const p = await arrive(t.staff, { reading: TODAY_READING });
    await choose(t.clergy2, { urgent_inbox: true }, { urgentIgnoresQuiet: false });
    expect(await noticeUrgentProposal(db, p.id, NIGHT, OWNERS)).toBe(2);
    expect(recipients()).toEqual(ids(t.owner, t.clergy));
    expect(await db.select().from(notificationHeld)).toMatchObject([{ userId: t.clergy2.id, kind: "urgent_inbox" }]);
  });
});

describe("the new Inbox kind", () => {
  beforeEach(async () => {
    for (const a of [t.clergy, t.clergy2, t.carer]) await device(a);
  });

  it("is off by default; once switched on it is one notice with a count, at most one per 30 minutes", async () => {
    for (let i = 0; i < 3; i++) await arrive(t.staff, { createdAt: at(T0, -5) });
    expect(await noticeNewInbox(db, T0, OWNERS)).toBe(0);
    await choose(t.clergy, { new_inbox: true });
    expect(await noticeNewInbox(db, T0, OWNERS)).toBe(1);
    expect(calls().map((c) => [c.endpoint.includes(t.clergy.id), c.payload])).toEqual([[true, { kind: "new_inbox", count: 3, path: "/inbox" }]]);
    // One more within the half hour: nothing yet.
    await arrive(t.staff, { createdAt: at(T0, 10) });
    expect(await noticeNewInbox(db, at(T0, 11), OWNERS)).toBe(0);
    // Past the half hour: one notice for what arrived since the last.
    expect(await noticeNewInbox(db, at(T0, 35), OWNERS)).toBe(1);
    expect(calls()[1].payload).toEqual({ kind: "new_inbox", count: 1, path: "/inbox" });
    expect(await noticeNewInbox(db, at(T0, 90), OWNERS)).toBe(0);
  });

  it("does not count the person's own captures, and never counts a private capture of someone else's", async () => {
    await choose(t.clergy, { new_inbox: true });
    await choose(t.clergy2, { new_inbox: true });
    await arrive(t.clergy, { scope: "submitter", createdAt: at(T0, -2) });
    expect(await noticeNewInbox(db, T0, OWNERS)).toBe(0);
    await arrive(t.clergy, { scope: "clergy", createdAt: at(T0, -2) });
    expect(await noticeNewInbox(db, at(T0, 1), OWNERS)).toBe(1);
    expect(recipients()).toEqual(ids(t.clergy2));
  });

  it("goes to clergy only: a caregiver, staff or a lead cannot switch it on", async () => {
    const saved = await savePrefs(db, t.carer, { kinds: { new_inbox: true, assigned: true }, quietEnabled: true, quietStartHour: 21, quietEndHour: 7, urgentIgnoresQuiet: true });
    expect(saved.kinds).toEqual({ assigned: true });
    await db.delete(notificationPrefs);
    // Even a stored 'on' for a kind the role is not offered is ignored.
    await db.execute(sql`insert into notification_prefs (user_id, kinds) values (${t.carer.id}, '{"new_inbox": true}'::jsonb)`);
    await arrive(t.staff, { createdAt: at(T0, -2) });
    await noticeNewInbox(db, T0, OWNERS);
    expect(sentTo(t.carer)).toEqual([]);
  });
});

describe("passed to you", () => {
  beforeEach(async () => {
    for (const a of [t.clergy, t.clergy2, t.carer, t.lead]) await device(a);
  });
  const item = (over: Record<string, unknown> = {}) => createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", ...over });

  it("tells the person it was given to, by someone else, and only if they can open it", async () => {
    const open = await item();
    expect(await noticeAssigned(db, { toUserId: t.clergy2.id, byUserId: t.clergy.id, careItemId: open.id }, T0, OWNERS)).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ payload: { kind: "assigned", path: "/" } });
    // Giving it to oneself is no news.
    expect(await noticeAssigned(db, { toUserId: t.clergy.id, byUserId: t.clergy.id, careItemId: open.id }, T0, OWNERS)).toBe(false);
    // A caregiver is told only about an item their role can see (visibility 'caregivers').
    const clergyOnly = await item();
    expect(await noticeAssigned(db, { toUserId: t.carer.id, byUserId: t.clergy.id, careItemId: clergyOnly.id }, T0, OWNERS)).toBe(false);
    const forCarer = await item({ visibility: "caregivers", ownerUserId: t.carer.id });
    expect(await noticeAssigned(db, { toUserId: t.carer.id, byUserId: t.clergy.id, careItemId: forCarer.id }, T0, OWNERS)).toBe(true);
  });

  it("a clergy member shut out of a restricted item gets nothing about it", async () => {
    const restricted = await item({ restricted: true });
    expect(await noticeAssigned(db, { toUserId: t.clergy2.id, byUserId: t.clergy.id, careItemId: restricted.id }, T0, OWNERS)).toBe(false);
    const stub = await createFollowUp(db, t.clergy, { careItemId: restricted.id, title: "Call", dueDate: "2026-12-05" });
    await db.update(followUps).set({ ownerUserId: t.clergy2.id }).where(eq(followUps.id, stub.id));
    expect(await noticeAssigned(db, { toUserId: t.clergy2.id, byUserId: t.clergy.id, followUpId: stub.id }, T0, OWNERS)).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
    // Named on the item, they may open it, and are told.
    const named = await item({ restricted: true, accessUserIds: [t.clergy2.id] });
    expect(await noticeAssigned(db, { toUserId: t.clergy2.id, byUserId: t.clergy.id, careItemId: named.id }, T0, OWNERS)).toBe(true);
  });

  it("is off when the person turned it off, and held (not lost) in quiet hours", async () => {
    const open = await item();
    await choose(t.clergy2, { assigned: false });
    expect(await noticeAssigned(db, { toUserId: t.clergy2.id, byUserId: t.clergy.id, careItemId: open.id }, T0, OWNERS)).toBe(false);
    await choose(t.clergy2, { assigned: true });
    expect(await noticeAssigned(db, { toUserId: t.clergy2.id, byUserId: t.clergy.id, careItemId: open.id }, NIGHT, OWNERS)).toBe(false);
    expect(await db.select().from(notificationHeld)).toMatchObject([{ userId: t.clergy2.id, kind: "assigned" }]);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("volunteer places (coordinators)", () => {
  beforeEach(async () => {
    for (const a of [t.owner, t.clergy, t.lead, t.carer, t.staff]) await device(a);
  });
  const taskInput = (date: string, over: Record<string, unknown> = {}) => ({ kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date, timeWindow: "2 to 4 pm", place: "41 Elm Court", contactLine: "Ask Dana", ...over });
  const vol = { firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "", mayAskAgain: false };

  it("a place given back within 3 days goes to the leads, by default, and to no one who cannot open the task", async () => {
    const task = await createVolunteerTask(db, t.lead, taskInput("2026-12-03"), NOW);
    expect(await noticePlaceOpened(db, { taskIds: [task.id] }, T0, OWNERS)).toBe(1);
    expect(recipients()).toEqual(ids(t.lead));
    expect(calls()[0].payload).toEqual({ kind: "volunteer_opened", path: "/volunteers" });
    // Far off: nothing. Past: nothing.
    sendNotification.mockClear();
    const far = await createVolunteerTask(db, t.lead, taskInput("2026-12-20"), NOW);
    expect(await noticePlaceOpened(db, { taskIds: [far.id] }, T0, OWNERS)).toBe(0);
    expect(await noticePlaceOpened(db, { taskIds: [task.id] }, new Date("2026-12-05T18:00:00Z"), OWNERS)).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("a rabbi's referral tells the leads in fixed words: not while a rabbi asks first, once only, and never once it is closed", async () => {
    const refer = (consent: string, over: Record<string, unknown> = {}) => createReferral(db, t.clergy, { sfContactId: CONTACT, kind: "meal", consent, contactLine: "Her mobile, 314 555 0100", note: "Side door", ...over }, { sf: fakeSf().sf, now: T0 });
    // Clergy and the owner are not told, even with the coordinator switch on: it is the leads' work.
    await choose(t.owner, { coordinator: true });
    await choose(t.clergy2, { coordinator: true });
    const waiting = await refer("rabbi_asks");
    expect(await noticeReferral(db, waiting.id, T0, OWNERS)).toBe(0);
    await setReferralConsent(db, t.clergy, waiting.id, "yes");
    expect(await noticeReferral(db, waiting.id, T0, OWNERS)).toBe(1);
    expect(recipients()).toEqual(ids(t.lead));
    expect(sentTo(t.lead).map((c) => c.payload)).toEqual([{ kind: "practical_request", path: "/volunteers" }]);
    expect(renderBody(sentTo(t.lead)[0].payload)).toBe("Someone asked Mitzvah Corps for help.");
    expect(JSON.stringify(calls())).not.toMatch(/Ruth|Cohen|mobile|Side door/);
    expect(await noticeReferral(db, waiting.id, at(T0, 45), OWNERS)).toBe(0);
    await withdrawReferral(db, t.clergy, waiting.id, T0);
    const gone = await refer("yes");
    await withdrawReferral(db, t.clergy, gone.id, T0);
    expect(await noticeReferral(db, gone.id, at(T0, 90), OWNERS)).toBe(0);
    // A lead who switched the coordinator kind off hears nothing.
    await choose(t.lead, { coordinator: false });
    const next = await refer("coordinator_asks");
    expect(await noticeReferral(db, next.id, at(T0, 120), OWNERS)).toBe(0);
    expect(sentTo(t.lead)).toHaveLength(1);
  });

  it("gives leads only the coordinator kinds: nothing from the Inbox", async () => {
    const p = await arrive(t.staff, { reading: TODAY_READING });
    await noticeUrgentProposal(db, p.id, T0, OWNERS);
    await noticeNewInbox(db, T0, OWNERS);
    expect(sentTo(t.lead)).toEqual([]);
    expect(sentTo(t.carer)).toEqual([]);
    expect(sentTo(t.staff)).toEqual([]);
  });

  it("a task linked to a restricted care item reaches only those who may open it", async () => {
    const restricted = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", restricted: true });
    const task = await createVolunteerTask(db, t.clergy, taskInput("2026-12-03", { careItemId: restricted.id }), NOW);
    await choose(t.clergy, { coordinator: true });
    await choose(t.owner, { coordinator: true });
    expect(await noticePlaceOpened(db, { taskIds: [task.id] }, T0, OWNERS)).toBe(1);
    // The lead (on by default) and the owner (switched on) are shut out of it; only its creator hears.
    expect(recipients()).toEqual(ids(t.clergy));
  });

  it("a volunteer giving a place back through their link still works, and never waits on or breaks for a notice", async () => {
    const task = await createVolunteerTask(db, t.lead, taskInput("2026-12-03"), NOW);
    const claimed = await claimTask(db, task.publicToken!, vol, meta(), NOW);
    if (!claimed.ok) throw new Error("claim refused");
    expect(await cancelMyClaim(db, claimed.manageToken, meta(), NOW)).toEqual({ ok: true });
  });

  it("a meal night given back within 3 days goes to the organisers who can open the page; not when it is further off", async () => {
    const page = await livePage(db, t.clergy);
    const slot = (date: string) => page.slots.find((s) => s.date === date)!;
    const signed = await signUpForMeal(db, page.publicToken, slot("2026-12-03").id, helper(), meta(), NOW);
    if (!signed.ok) throw new Error("sign-up refused");
    expect(await cancelMySignup(db, signed.manageToken, meta(), NOW)).toEqual({ ok: true });
    expect(await noticePlaceOpened(db, { mealPageId: page.id, slotDate: "2026-12-03" }, T0, OWNERS)).toBe(1);
    expect(recipients()).toEqual(ids(t.lead));
    sendNotification.mockClear();
    expect(await noticePlaceOpened(db, { mealPageId: page.id, slotDate: "2026-12-05" }, T0, OWNERS)).toBe(0);
    // A staff member who is not an organiser of the page cannot open it: nothing, even when they turn the kind on.
    await choose(t.staff, { coordinator: true });
    expect(await noticePlaceOpened(db, { mealPageId: page.id, slotDate: "2026-12-03" }, at(T0, 1), OWNERS)).toBe(1);
    expect(sentTo(t.staff)).toEqual([]);
  });

  it("the daily job counts asks within 2 days that still need someone, once per person per day", async () => {
    const need = await createVolunteerTask(db, t.lead, taskInput("2026-12-03"), NOW);
    const full = await createVolunteerTask(db, t.lead, taskInput("2026-12-02"), NOW);
    const later = await createVolunteerTask(db, t.lead, taskInput("2026-12-09"), NOW);
    const taken = await claimTask(db, full.publicToken!, vol, meta(), NOW);
    expect(taken.ok).toBe(true);
    expect(need.id && later.id).toBeTruthy();
    expect(await noticeUnfilledAsks(db, JOB, OWNERS)).toEqual({ people: 1, sent: 1 });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ endpoint: expect.stringContaining(t.lead.id), payload: { kind: "volunteer_asks", count: 1, path: "/volunteers" } });
    // Run again the same morning: no second notice.
    expect(await noticeUnfilledAsks(db, at(JOB, 5), OWNERS)).toEqual({ people: 1, sent: 0 });
  });
});

describe("quiet hours", () => {
  beforeEach(async () => {
    await device(t.clergy);
    await choose(t.clergy, { new_inbox: true, assigned: true, urgent_inbox: true });
  });

  it("holds non-urgent notices overnight (one row per kind, the latest count), and the urgent one goes through", async () => {
    await arrive(t.staff, { createdAt: at(NIGHT, -3) });
    await arrive(t.staff, { createdAt: at(NIGHT, -2) });
    expect(await noticeNewInbox(db, NIGHT, OWNERS)).toBe(0);
    expect(await db.select().from(notificationHeld)).toMatchObject([{ kind: "new_inbox", count: 2 }]);
    await arrive(t.staff, { createdAt: at(NIGHT, -1) });
    await noticeNewInbox(db, at(NIGHT, 5), OWNERS);
    expect(await db.select().from(notificationHeld)).toMatchObject([{ kind: "new_inbox", count: 3 }]);
    expect(sendNotification).not.toHaveBeenCalled();
    const urgent = await arrive(t.staff, { reading: TODAY_READING });
    expect(await noticeUrgentProposal(db, urgent.id, at(NIGHT, 6), OWNERS)).toBe(1);
    expect(calls().map((c) => c.payload.kind)).toEqual(["urgent_inbox"]);
  });

  it("flushes what was held as ONE notice when the daily job runs at the end of quiet hours, then forgets it", async () => {
    const open = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    await arrive(t.staff, { createdAt: at(NIGHT, -3) });
    await noticeNewInbox(db, NIGHT, OWNERS);
    await noticeAssigned(db, { toUserId: t.clergy.id, byUserId: t.clergy2.id, careItemId: open.id }, at(NIGHT, 1), OWNERS);
    expect(await db.select().from(notificationHeld)).toHaveLength(2);
    expect(await flushHeld(db, JOB, OWNERS)).toEqual({ stale: 0, sent: 1, waiting: 0 });
    expect(calls().map((c) => c.payload)).toEqual([{ kind: "assigned", path: "/" }]);
    expect(await db.select().from(notificationHeld)).toEqual([]);
  });

  it("drops what is stale, and keeps what is held while quiet hours still have a long way to run", async () => {
    await db.insert(notificationHeld).values({ userId: t.clergy.id, kind: "new_inbox", count: 4, createdAt: new Date(JOB.getTime() - 15 * HOUR) });
    expect(await flushHeld(db, JOB, OWNERS)).toEqual({ stale: 1, sent: 0, waiting: 0 });
    await db.insert(notificationHeld).values({ userId: t.clergy.id, kind: "assigned", count: null, createdAt: at(JOB, -60) });
    await choose(t.clergy, { assigned: true }, { quietEndHour: 10 });
    expect(await flushHeld(db, JOB, OWNERS)).toEqual({ stale: 0, sent: 0, waiting: 1 });
    expect(await db.select().from(notificationHeld)).toHaveLength(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("with quiet hours switched off, nothing is held", async () => {
    await choose(t.clergy, { new_inbox: true }, { quietEnabled: false });
    await arrive(t.staff, { createdAt: at(NIGHT, -3) });
    expect(await noticeNewInbox(db, NIGHT, OWNERS)).toBe(1);
    expect(await db.select().from(notificationHeld)).toEqual([]);
  });

  it("the log of what was sent is forgotten after 30 days", async () => {
    await db.insert(notificationLog).values([
      { userId: t.clergy.id, kind: "assigned", createdAt: new Date(NOW.getTime() - 31 * 24 * HOUR) },
      { userId: t.clergy.id, kind: "assigned", createdAt: new Date(NOW.getTime() - 2 * 24 * HOUR) },
    ]);
    expect(await purgeNotificationLog(db, NOW)).toBe(1);
    expect(await db.select().from(notificationLog)).toHaveLength(1);
  });
});

describe("the morning summary on the phone", () => {
  const overdue = async (actor: Actor) => {
    const item = await createCareItem(db, actor, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    await createFollowUp(db, actor, { careItemId: item.id, title: "Call", dueDate: "2026-11-20" });
  };

  it("hands the channel exactly the counts-only message from summaryMessage, plus the counts", async () => {
    const push = vi.fn(async () => "sent" as const);
    const summary = { overdue: 2, dueToday: 1, inbox: 0, newSteps: 0 };
    const out = await deliverSummary({ id: t.clergy.id, pref: "both" }, summary, "https://care.example", { email: NOT_CONFIGURED.email, push });
    expect(push).toHaveBeenCalledWith(t.clergy.id, summaryMessage(summary, "https://care.example"), summary);
    expect(out).toEqual({ email: "not_configured", push: "sent" });
    expect(await deliverSummary({ id: t.clergy.id, pref: "email" }, summary, "https://care.example", { email: NOT_CONFIGURED.email, push })).toMatchObject({ push: "not_chosen" });
    expect(await deliverSummary({ id: t.clergy.id, pref: "push" }, { overdue: 0, dueToday: 0, inbox: 0, newSteps: 0 }, "https://care.example", { email: NOT_CONFIGURED.email, push })).toEqual({ email: "not_chosen", push: "not_chosen" });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("sends one notice with the total, for a person whose choice includes a phone notification; nothing on an empty day", async () => {
    await device(t.clergy);
    await device(t.clergy2);
    await overdue(t.clergy);
    await setSummaryPref(db, t.clergy, "push");
    await setSummaryPref(db, t.clergy2, "push");
    const channels = { email: NOT_CONFIGURED.email, push: pushSummaryChannel(db, JOB, OWNERS) };
    const tally = await runMorningSummaries(db, JOB, OWNERS, "https://care.example", channels);
    expect(tally).toMatchObject({ stored: 1, sent: 1 });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ endpoint: expect.stringContaining(t.clergy.id), payload: { kind: "morning_summary", count: 1, path: "/" }, options: { urgency: "low" } });
    // The same morning again: not twice.
    await runMorningSummaries(db, JOB, OWNERS, "https://care.example", channels);
    expect(calls()).toHaveLength(1);
  });

  it("a person who chose email only gets no phone notice, and with the keys missing the channel says not configured", async () => {
    await device(t.clergy);
    await overdue(t.clergy);
    await setSummaryPref(db, t.clergy, "email");
    await runMorningSummaries(db, JOB, OWNERS, "https://care.example", { email: NOT_CONFIGURED.email, push: pushSummaryChannel(db, JOB, OWNERS) });
    expect(sendNotification).not.toHaveBeenCalled();
    await setSummaryPref(db, t.clergy, "push");
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    const tally = await runMorningSummaries(db, JOB, OWNERS, "https://care.example", { email: NOT_CONFIGURED.email, push: pushSummaryChannel(db, JOB, OWNERS) });
    expect(tally).toMatchObject({ pushNotConfigured: 1, sent: 0 });
  });

  it("the daily job has the new tasks, and the clean-up one deletes old revoked devices and forgets old log rows", async () => {
    expect(DAILY_TASKS.map((x) => x.key)).toEqual(expect.arrayContaining(["volunteer_asks_notice", "push_upkeep", "morning_summary"]));
    expect(DAILY_TASKS.at(-2)!.key).toBe("morning_summary");
    await device(t.clergy);
    await db.update(pushSubscriptions).set({ revokedAt: new Date(JOB.getTime() - 40 * 24 * HOUR) });
    const upkeep = DAILY_TASKS.find((x) => x.key === "push_upkeep")!;
    expect(await upkeep.run({ db, now: JOB, owners: OWNERS, origin: null })).toMatchObject({ revokedDeleted: 1, logDeleted: 0, heldStale: 0 });
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });
});

describe("a person who is not allowed in gets nothing", () => {
  it("a deactivated person is never notified, even with a device and the kind on", async () => {
    const gone = await addActor(db, "gone@example.test", "clergy", false);
    await device(gone);
    const p = await arrive(t.staff, { reading: TODAY_READING });
    expect(await noticeUrgentProposal(db, p.id, T0, OWNERS)).toBe(0);
    expect(sentTo(gone)).toEqual([]);
  });
});

describe("urgent notices are capped, so nobody can make a phone buzz without end", () => {
  beforeEach(async () => {
    await device(t.clergy);
    await choose(t.clergy, { urgent_inbox: true });
  });
  const urgent = async (when: Date) => {
    const p = await arrive(t.staff, { reading: TODAY_READING });
    return noticeUrgentProposal(db, p.id, when, OWNERS);
  };
  const formUrgent = async (when: Date) => {
    const [p] = await db.insert(proposals).values({ channel: "form", submittedBy: null, submitterLabel: "Public form", rawText: "Words from a stranger", reading: TODAY_READING, reviewScope: "clergy" }).returning({ id: proposals.id });
    return noticeUrgentProposal(db, p.id, when, OWNERS);
  };
  const kinds = () => calls().map((c) => c.payload.kind);

  it("at most 3 an hour: the rest fold into one 'N things need you today.' notice, at most once an hour", async () => {
    const sent = [];
    for (const m of [0, 1, 2, 3, 4]) sent.push(await urgent(at(T0, m)));
    expect(sent).toEqual([1, 1, 1, 0, 0]);
    expect(kinds()).toEqual(["urgent_inbox", "urgent_inbox", "urgent_inbox", "urgent_digest"]);
    expect(calls()[3].payload).toEqual({ kind: "urgent_digest", count: 1, path: "/inbox" });
    // The fifth is held in the digest count, not sent: one digest an hour.
    expect(await db.select().from(notificationHeld)).toMatchObject([{ kind: "urgent_digest", count: 1 }]);
    expect(renderBody(calls()[3].payload)).toBe("1 thing needs you today.");
  });

  it("at most 8 a day", async () => {
    for (let i = 0; i < 8; i++) expect(await urgent(at(T0, i * 61))).toBe(1);
    expect(await urgent(at(T0, 8 * 61))).toBe(0);
    expect(kinds().filter((k) => k === "urgent_inbox")).toHaveLength(8);
    expect(kinds().at(-1)).toBe("urgent_digest");
  });

  it("in quiet hours at most 2 a night; the rest are held to the end of quiet hours", async () => {
    expect(await urgent(at(T0, 8 * 60))).toBe(1); // 8 pm, before quiet hours: does not count against the night
    expect(await urgent(NIGHT)).toBe(1);
    expect(await urgent(at(NIGHT, 1))).toBe(1);
    expect(await urgent(at(NIGHT, 2))).toBe(0);
    expect(kinds()).toHaveLength(3);
    expect(await db.select().from(notificationHeld)).toMatchObject([{ kind: "urgent_inbox" }]);
    expect(await flushHeld(db, JOB, OWNERS)).toMatchObject({ sent: 1 });
    expect(calls().at(-1)!.payload).toEqual({ kind: "urgent_overnight", path: "/inbox" });
  });

  it("a public-form report never wakes anyone on the AI's reading alone: held in quiet hours, even with 'let urgent through' on", async () => {
    expect((await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, t.clergy.id)))[0].urgentIgnoresQuiet).toBe(true);
    expect(await formUrgent(NIGHT)).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await db.select().from(notificationHeld)).toMatchObject([{ kind: "urgent_inbox" }]);
    // At the end of quiet hours it is one plain notice.
    expect(await flushHeld(db, JOB, OWNERS)).toMatchObject({ sent: 1 });
    expect(kinds()).toEqual(["urgent_overnight"]);
  });

  it("in the day a public-form report counts toward the cap like the others", async () => {
    expect([await formUrgent(T0), await formUrgent(at(T0, 1)), await urgent(at(T0, 2)), await formUrgent(at(T0, 3))]).toEqual([1, 1, 1, 0]);
    expect(kinds()).toEqual(["urgent_inbox", "urgent_inbox", "urgent_inbox", "urgent_digest"]);
  });

  it("Salesforce deaths count toward the same caps", async () => {
    for (const m of [0, 1, 2]) await urgent(at(T0, m));
    await createSalesforceProposal(db, { externalKey: "sf:death:cap", rawText: "Start the bereavement year?", intake: { kind: "salesforce", event: "death", subjectId: CONTACT, accountId: null, household: null } });
    expect(await noticeUrgentByKey(db, "sf:death:cap", at(T0, 3), OWNERS)).toBe(0);
    expect(kinds()).toEqual(["urgent_inbox", "urgent_inbox", "urgent_inbox", "urgent_digest"]);
  });

  it("a held urgent notice is never dropped as stale; an old non-urgent one is", async () => {
    await db.insert(notificationHeld).values([
      { userId: t.clergy.id, kind: "urgent_inbox", count: null, createdAt: new Date(JOB.getTime() - 20 * HOUR) },
      { userId: t.clergy.id, kind: "new_inbox", count: 3, createdAt: new Date(JOB.getTime() - 20 * HOUR) },
    ]);
    expect(await flushHeld(db, JOB, OWNERS)).toEqual({ stale: 1, sent: 1, waiting: 0 });
    expect(calls().map((c) => c.payload)).toEqual([{ kind: "urgent_overnight", path: "/inbox" }]);
    expect(renderBody(calls()[0].payload)).toBe("Something needed you overnight.");
  });

  it("when quiet hours end after the daily job, the next notice for that person sends what was held first", async () => {
    await choose(t.clergy, { assigned: true, urgent_inbox: true }, { quietEndHour: 10 });
    await db.insert(notificationHeld).values({ userId: t.clergy.id, kind: "new_inbox", count: 2, createdAt: at(JOB, -60) });
    expect(await flushHeld(db, JOB, OWNERS)).toEqual({ stale: 0, sent: 0, waiting: 1 });
    const open = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    // Still quiet at 9: nothing. After 10: the held notice, then this one.
    expect(await noticeAssigned(db, { toUserId: t.clergy.id, byUserId: t.clergy2.id, careItemId: open.id }, new Date("2026-12-02T15:00:00Z"), OWNERS)).toBe(false);
    const another = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    expect(await noticeAssigned(db, { toUserId: t.clergy.id, byUserId: t.clergy2.id, careItemId: another.id }, new Date("2026-12-02T16:30:00Z"), OWNERS)).toBe(true);
    expect(kinds()).toEqual(["assigned", "assigned"]); // what was held (the 9 am attempt outranks the older new-Inbox count), then this one
    expect(await db.select().from(notificationHeld)).toEqual([]);
  });
});

describe("passed to you: once per item, and one notice when several arrive together", () => {
  beforeEach(async () => {
    await device(t.clergy2);
  });
  const item = (over: Record<string, unknown> = {}) => createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", ...over });

  it("the same item twice in one window is one notice; a second item within 10 minutes becomes 'N things were passed to you.'", async () => {
    const a = await item();
    const b = await item();
    const give = (id: string, when: Date) => noticeAssigned(db, { toUserId: t.clergy2.id, byUserId: t.clergy.id, careItemId: id }, when, OWNERS);
    expect(await give(a.id, T0)).toBe(true);
    expect(await give(a.id, at(T0, 1))).toBe(false);
    expect(await give(b.id, at(T0, 3))).toBe(true);
    expect(calls().map((c) => c.payload)).toEqual([
      { kind: "assigned", path: "/" },
      { kind: "assigned_many", count: 2, path: "/" },
    ]);
    expect(renderBody(calls()[1].payload)).toBe("2 things were passed to you.");
  });

  it("a hand-over to one person is one notice counting only what they can open", async () => {
    const open1 = await item();
    const open2 = await item();
    const hidden = await item({ restricted: true });
    const { noticeAssignedMany } = await import("@/server/notify/notify");
    expect(await noticeAssignedMany(db, { toUserId: t.clergy2.id, byUserId: t.owner.id, careItemIds: [open1.id, open2.id, hidden.id], followUpIds: [] }, T0, OWNERS)).toBe(true);
    expect(calls().map((c) => c.payload)).toEqual([{ kind: "assigned_many", count: 2, path: "/" }]);
    expect(await noticeAssignedMany(db, { toUserId: t.clergy2.id, byUserId: t.clergy2.id, careItemIds: [open1.id], followUpIds: [] }, T0, OWNERS)).toBe(false);
    expect(await noticeAssignedMany(db, { toUserId: t.clergy2.id, byUserId: t.owner.id, careItemIds: [hidden.id], followUpIds: [] }, at(T0, 20), OWNERS)).toBe(false);
  });
});
