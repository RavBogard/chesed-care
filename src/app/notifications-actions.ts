"use server";

import { headers } from "next/headers";
import { noticeKindsFor } from "@/server/access/policy";
import { fields, runAction, runData, type DataState } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import type { ActionState } from "@/lib/action-state";
import { savePrefs } from "@/server/notify/prefs";
import { removeDevice, removeDeviceByEndpoint, subscribeDevice } from "@/server/notify/subscriptions";
import { sendTestNotice, type TestResult } from "@/server/notify/test-send";

/** A browser's subscription, as the screen hands it over after the person said yes to the browser's own question. Always the signed-in person's own device. */
export async function subscribeDeviceAction(input: { endpoint: string; p256dh: string; auth: string }): Promise<DataState<{ deviceLabel: string }>> {
  return runData(await getViewer(), async (actor, db) => {
    const userAgent = (await headers()).get("user-agent");
    const made = await subscribeDevice(db, actor, { endpoint: input?.endpoint, p256dh: input?.p256dh, auth: input?.auth, userAgent });
    return { deviceLabel: made.deviceLabel };
  });
}

/** Turn off the device I am using, found by its own address. */
export async function turnOffThisDeviceAction(input: { endpoint: string }): Promise<DataState<null>> {
  return runData(await getViewer(), async (actor, db) => {
    await removeDeviceByEndpoint(db, actor, input?.endpoint);
    return null;
  });
}

/** Turn one of my own devices off. */
export async function removeDeviceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await removeDevice(db, actor, f.deviceId);
    return "Turned off.";
  });
}

const TEST_WORDS: Record<TestResult, string> = {
  sent: "Sent. It should arrive in a moment.",
  not_configured: "Phone notifications are not set up yet.",
  no_device: "No device is turned on yet.",
  failed: "It could not be sent. Try turning notifications off and on again on this device.",
};

/** Send myself one test notice, on my own devices. */
export async function sendTestNotificationAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  void _form;
  const viewer = await getViewer();
  const outcome = await runData(viewer, (actor, db) => sendTestNotice(db, actor));
  if (outcome.status === "error") return outcome;
  return outcome.data === "sent" ? { status: "ok", message: TEST_WORDS.sent } : { status: "error", message: TEST_WORDS[outcome.data] };
}

/** Save my own switches and quiet hours. */
export async function saveNotificationPrefsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const kinds: Record<string, boolean> = {};
    for (const kind of noticeKindsFor(actor)) kinds[kind] = f[`kind_${kind}`] === "on";
    await savePrefs(db, actor, { kinds, quietEnabled: f.quietEnabled === "on", quietStartHour: f.quietStartHour, quietEndHour: f.quietEndHour, urgentIgnoresQuiet: f.urgentIgnoresQuiet === "on" });
    return "Saved.";
  });
}
