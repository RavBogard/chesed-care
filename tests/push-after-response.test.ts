import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { createProposal } from "@/server/care/proposals";
import type { Db } from "@/server/db/types";
import { subscribeDevice } from "@/server/notify/subscriptions";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";

const hoisted = vi.hoisted(() => ({ generate: vi.fn(), later: [] as (() => Promise<void> | void)[], push: vi.fn(), viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("ai", async (importActual) => ({ ...(await importActual<typeof import("ai")>()), generateText: hoisted.generate }));
vi.mock("next/server", async (importActual) => ({ ...(await importActual<typeof import("next/server")>()), after: (fn: () => Promise<void> | void) => void hoisted.later.push(fn) }));
vi.mock("web-push", () => ({ default: { sendNotification: hoisted.push } }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => hoisted.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => hoisted.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { reassignCareItemAction, reassignFollowUpAction } from "@/app/team-actions";
import { handOverWorkAction } from "@/app/settings-actions";
import { readAgain } from "@/server/care/ai-reading";

const NOW = new Date("2026-12-01T18:00:00Z");
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const IDLE = { status: "idle" } as const;
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;

/** Run everything the code left for after the response, as the platform would. */
async function afterTheResponse() {
  const queue = hoisted.later.splice(0);
  for (const task of queue) await task();
}
const kindsSent = () => hoisted.push.mock.calls.map(([, payload]) => (JSON.parse(payload as string) as { kind: string }).kind);

beforeEach(async () => {
  // Only the clock is fixed (noon in St. Louis, outside quiet hours); timers and promises are real.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  process.env.OWNER_EMAILS = "owner@example.test";
  vi.stubEnv("VAPID_PUBLIC_KEY", "BPublicKeyForTestsOnly");
  vi.stubEnv("VAPID_PRIVATE_KEY", "private-key-for-tests-only");
  vi.stubEnv("VAPID_SUBJECT", "mailto:care@example.test");
  vi.stubEnv("CARE_AI_SORTING", "on");
  vi.stubEnv("VERCEL_ENV", "");
  hoisted.generate.mockReset();
  hoisted.push.mockReset();
  hoisted.push.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  hoisted.later.length = 0;
  db = await testDb();
  hoisted.db = db;
  t = await team(db);
  r = await reporters(db);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("a push is never awaited inside a user action", () => {
  it("reading again leaves the urgent notice for after the response, then sends it", async () => {
    await subscribeDevice(db, t.clergy, { endpoint: "https://fcm.googleapis.com/fcm/send/a", ...KEYS });
    const text = "Ruth Cohen is in Barnes hospital, surgery on Tuesday.";
    const made = await createProposal(db, r.staff, { rawText: text, channel: "staff" });
    hoisted.later.length = 0;
    hoisted.generate.mockResolvedValue({ output: { names: ["Ruth Cohen"], summary: "Ruth Cohen is in hospital.", category: "illness", urgency: "today", dates: [], sensitive: false, followUp: "Call", evidence: [] } });
    // The push service would never answer: the action must still finish.
    hoisted.push.mockImplementation(() => new Promise(() => undefined));
    expect(await readAgain(db, t.clergy2, made.id, NOW)).toBe("read");
    expect(hoisted.push).not.toHaveBeenCalled();
    expect(hoisted.later).toHaveLength(1);
    hoisted.push.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await afterTheResponse();
    expect(kindsSent()).toEqual(["urgent_inbox"]);
  });

  it("passing a care item or a follow-up on sends 'passed to you' after the response, only when the holder really changed and is not the person acting", async () => {
    await subscribeDevice(db, t.clergy2, { endpoint: "https://fcm.googleapis.com/fcm/send/b", ...KEYS });
    hoisted.viewer = { kind: "ok", actor: t.owner };
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    const followUp = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: "2026-12-05" });
    // The same holder again: nothing queued.
    expect(await reassignCareItemAction(IDLE, form({ careItemId: item.id, ownerUserId: t.clergy.id }))).toMatchObject({ status: "ok" });
    expect(await reassignFollowUpAction(IDLE, form({ followUpId: followUp.id, ownerUserId: t.clergy.id }))).toMatchObject({ status: "ok" });
    await afterTheResponse();
    expect(hoisted.push).not.toHaveBeenCalled();
    // Given to someone else: one notice, after the response.
    expect(await reassignCareItemAction(IDLE, form({ careItemId: item.id, ownerUserId: t.clergy2.id }))).toMatchObject({ status: "ok" });
    expect(hoisted.push).not.toHaveBeenCalled();
    await afterTheResponse();
    expect(kindsSent()).toEqual(["assigned"]);
    // Given to oneself: nothing.
    hoisted.push.mockClear();
    hoisted.viewer = { kind: "ok", actor: t.clergy2 };
    expect(await reassignFollowUpAction(IDLE, form({ followUpId: followUp.id, ownerUserId: t.clergy2.id }))).toMatchObject({ status: "ok" });
    await afterTheResponse();
    expect(hoisted.push).not.toHaveBeenCalled();
  });

  it("the hand-over sheet sends one notice to each person who was given work", async () => {
    await subscribeDevice(db, t.clergy, { endpoint: "https://fcm.googleapis.com/fcm/send/c", ...KEYS });
    hoisted.viewer = { kind: "ok", actor: t.owner };
    for (const n of [1, 2]) {
      const item = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: `Ruth ${n}`, category: "illness" });
      await createFollowUp(db, t.clergy2, { careItemId: item.id, title: "Call", dueDate: "2026-12-05" });
    }
    const done = await handOverWorkAction(IDLE, form({ userId: t.clergy2.id, itemsTo: t.clergy.id, followUpsTo: t.clergy.id, leadStepsTo: t.clergy.id }));
    expect(done).toMatchObject({ status: "ok" });
    expect(hoisted.push).not.toHaveBeenCalled();
    await afterTheResponse();
    expect(hoisted.push).toHaveBeenCalledTimes(1);
    expect(JSON.parse(hoisted.push.mock.calls[0][1] as string)).toEqual({ kind: "assigned_many", count: 4, path: "/" });
  });
});
