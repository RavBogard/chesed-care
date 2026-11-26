import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationPrefs, pushSubscriptions } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { listDevices, subscribeDevice } from "@/server/notify/subscriptions";
import { team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130 Mobile Safari" }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));
vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));

import SettingsPage from "@/app/settings/page";
import { removeDeviceAction, saveNotificationPrefsAction, sendTestNotificationAction, subscribeDeviceAction, turnOffThisDeviceAction } from "@/app/notifications-actions";
import * as notificationActions from "@/app/notifications-actions";

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const PUSH_ENV = { VAPID_PUBLIC_KEY: "BPublicKeyForTestsOnly", VAPID_PRIVATE_KEY: "private-key-for-tests-only", VAPID_SUBJECT: "mailto:care@example.test" };
const SECRET_VALUE = PUSH_ENV.VAPID_PRIVATE_KEY;
const endpoint = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const IDLE = { status: "idle" } as const;

let db: Db;
let t: Awaited<ReturnType<typeof team>>;

beforeEach(async () => {
  process.env.OWNER_EMAILS = "owner@example.test";
  db = await testDb();
  state.db = db;
  t = await team(db);
});
afterEach(() => vi.unstubAllEnvs());

describe("the Notifications block in Settings", () => {
  it("says it is not switched on, and shows only the owner which variables are missing (names, never values)", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", SECRET_VALUE);
    vi.stubEnv("VAPID_SUBJECT", "");
    state.viewer = { kind: "ok", actor: t.owner };
    const owner = renderToStaticMarkup(await SettingsPage());
    expect(owner).toContain("Phone notifications are not switched on yet.");
    expect(owner).toContain("Not set up yet. Missing: VAPID_PUBLIC_KEY, VAPID_SUBJECT.");
    expect(owner).not.toContain(SECRET_VALUE);
    state.viewer = { kind: "ok", actor: t.clergy };
    const clergy = renderToStaticMarkup(await SettingsPage());
    expect(clergy).toContain("Phone notifications are not switched on yet.");
    expect(clergy).not.toContain("VAPID_");
  });

  it("when set up: the device control, the devices, the test button and only the switches the role has, with their defaults", async () => {
    for (const [k, v] of Object.entries(PUSH_ENV)) vi.stubEnv(k, v);
    await subscribeDevice(db, t.clergy, { endpoint: endpoint("clergy-phone"), ...KEYS, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
    state.viewer = { kind: "ok", actor: t.clergy };
    const clergy = renderToStaticMarkup(await SettingsPage());
    expect(clergy).toContain('data-testid="device-control"');
    expect(clergy).toContain('data-testid="push-devices"');
    expect(clergy).toContain("iPhone");
    expect(clergy).toContain("Send me a test");
    for (const name of ["kind_urgent_inbox", "kind_new_inbox", "kind_assigned", "kind_coordinator"]) expect(clergy).toContain(`name="${name}"`);
    expect(clergy).toMatch(/name="kind_urgent_inbox"[^>]*checked/);
    expect(clergy).not.toMatch(/name="kind_new_inbox"[^>]*checked/);
    // Nothing secret reaches the page, and the endpoint is never shown.
    expect(clergy).not.toContain(SECRET_VALUE);
    expect(clergy).not.toContain("fcm.googleapis.com");
    expect(clergy).not.toContain(KEYS.auth);
    state.viewer = { kind: "ok", actor: t.carer };
    const carer = renderToStaticMarkup(await SettingsPage());
    expect(carer).toContain('name="kind_assigned"');
    expect(carer).not.toContain('name="kind_urgent_inbox"');
    expect(carer).not.toContain('name="kind_new_inbox"');
    expect(carer).toContain("No device has notifications on yet.");
    expect(carer).not.toContain("Send me a test");
    expect(carer).toContain("Quiet hours");
  });
});

describe("the notification actions are the signed-in person's own", () => {
  it("every one refuses a signed-out visitor", async () => {
    for (const k of Object.keys(PUSH_ENV)) vi.stubEnv(k, PUSH_ENV[k as keyof typeof PUSH_ENV]);
    state.viewer = { kind: "signed-out" };
    expect(await subscribeDeviceAction({ endpoint: endpoint("x"), ...KEYS })).toMatchObject({ status: "error" });
    expect(await turnOffThisDeviceAction({ endpoint: endpoint("x") })).toMatchObject({ status: "error" });
    for (const action of [removeDeviceAction, sendTestNotificationAction, saveNotificationPrefsAction]) expect(await action(IDLE, form({ deviceId: "x" }))).toMatchObject({ status: "error", message: "Please sign in again." });
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  it("subscribing saves the device for the signed-in person with a broad label; turning off by address cannot touch someone else's", async () => {
    state.viewer = { kind: "ok", actor: t.clergy };
    expect(await subscribeDeviceAction({ endpoint: endpoint("mine"), ...KEYS })).toEqual({ status: "ok", data: { deviceLabel: "Android phone" } });
    expect(await listDevices(db, t.clergy)).toHaveLength(1);
    state.viewer = { kind: "ok", actor: t.clergy2 };
    expect(await turnOffThisDeviceAction({ endpoint: endpoint("mine") })).toMatchObject({ status: "ok" });
    expect(await listDevices(db, t.clergy)).toHaveLength(1);
    state.viewer = { kind: "ok", actor: t.clergy };
    expect(await turnOffThisDeviceAction({ endpoint: endpoint("mine") })).toMatchObject({ status: "ok" });
    expect(await listDevices(db, t.clergy)).toHaveLength(0);
    expect(await subscribeDeviceAction({ endpoint: "https://evil.example/x", ...KEYS })).toMatchObject({ status: "error" });
  });

  it("turning a device off by its id works for the owner of the device only", async () => {
    const mine = await subscribeDevice(db, t.clergy, { endpoint: endpoint("a"), ...KEYS });
    state.viewer = { kind: "ok", actor: t.clergy2 };
    expect(await removeDeviceAction(IDLE, form({ deviceId: mine.id }))).toMatchObject({ status: "error" });
    expect(await listDevices(db, t.clergy)).toHaveLength(1);
    state.viewer = { kind: "ok", actor: t.clergy };
    expect(await removeDeviceAction(IDLE, form({ deviceId: mine.id }))).toEqual({ status: "ok", message: "Turned off." });
    expect(await listDevices(db, t.clergy)).toHaveLength(0);
  });

  it("the test notice says plainly when notifications are not set up, or no device is on", async () => {
    state.viewer = { kind: "ok", actor: t.clergy };
    expect(await sendTestNotificationAction(IDLE, form({}))).toEqual({ status: "error", message: "Phone notifications are not set up yet." });
    for (const [k, v] of Object.entries(PUSH_ENV)) vi.stubEnv(k, v);
    expect(await sendTestNotificationAction(IDLE, form({}))).toEqual({ status: "error", message: "No device is turned on yet." });
  });

  it("saving stores only the switches the role is offered, and the quiet hours, on the person's own row", async () => {
    state.viewer = { kind: "ok", actor: t.carer };
    const saved = await saveNotificationPrefsAction(IDLE, form({ kind_assigned: "on", kind_new_inbox: "on", quietEnabled: "on", quietStartHour: "22", quietEndHour: "6" }));
    expect(saved).toEqual({ status: "ok", message: "Saved." });
    const rows = await db.select().from(notificationPrefs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: t.carer.id, kinds: { assigned: true }, quietEnabled: true, quietStartHour: 22, quietEndHour: 6, urgentIgnoresQuiet: false });
    expect(await saveNotificationPrefsAction(IDLE, form({ kind_assigned: "on", quietStartHour: "25", quietEndHour: "6" }))).toMatchObject({ status: "error" });
    expect((await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, t.carer.id)))[0].quietStartHour).toBe(22);
  });

  it("exports only actions, each of which resolves the viewer (the guard also checks this)", () => {
    expect(Object.keys(notificationActions).sort()).toEqual(["removeDeviceAction", "saveNotificationPrefsAction", "sendTestNotificationAction", "subscribeDeviceAction", "turnOffThisDeviceAction"]);
  });
});
