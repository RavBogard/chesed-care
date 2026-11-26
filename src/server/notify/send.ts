/**
 * Sending one notice to one person's devices through the push service, signed with the app's VAPID keys.
 * `sendPush` takes a Notice from the closed set (src/lib/notice.ts): there is no way to hand it words.
 *
 * Nothing here logs an endpoint, a key or a payload: when something is worth a line it is a fixed label
 * and the error's class name. A 404 or 410 from the push service means the device is gone and revokes it;
 * any other failure counts, and five in a row revoke it.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { NOTICE_TEMPLATES, noticePayload, type Notice } from "@/lib/notice";
import { pushSubscriptions } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { pushStatus, vapidDetails } from "./config";

export const MAX_FAILURES = 5;
/** One overall time budget for sending a notice to all of a person's devices. */
export const SEND_BUDGET_MS = 10_000;

export type SendResult = { status: "not_configured" } | { status: "done"; devices: number; sent: number; failed: number; revoked: number };

type PushError = { statusCode?: unknown; name?: unknown };

/** Send a notice to every device the person has on. Never throws for a push-service failure. */
export async function sendPush(db: Db, userId: string, notice: Notice, now: Date = new Date()): Promise<SendResult> {
  const vapid = vapidDetails();
  if (!vapid) return { status: "not_configured" };
  const payload = JSON.stringify(noticePayload(notice));
  const template = NOTICE_TEMPLATES[notice.kind];
  const devices = await db.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));
  const result = { devices: devices.length, sent: 0, failed: 0, revoked: 0 };
  const sendTo = async (device: (typeof devices)[number]): Promise<void> => {
    try {
      await webpush.sendNotification({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload, {
        TTL: template.ttl,
        urgency: template.urgency,
        topic: template.tag,
        vapidDetails: vapid,
        timeout: SEND_BUDGET_MS,
      });
      await db.update(pushSubscriptions).set({ lastSuccessAt: now, failureCount: 0 }).where(eq(pushSubscriptions.id, device.id));
      result.sent++;
    } catch (error) {
      const code = (error as PushError).statusCode;
      if (code === 404 || code === 410) {
        await db.update(pushSubscriptions).set({ revokedAt: now }).where(eq(pushSubscriptions.id, device.id));
        result.revoked++;
        return;
      }
      const [row] = await db
        .update(pushSubscriptions)
        .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
        .where(eq(pushSubscriptions.id, device.id))
        .returning({ failureCount: pushSubscriptions.failureCount });
      if (row && row.failureCount >= MAX_FAILURES) {
        await db.update(pushSubscriptions).set({ revokedAt: now }).where(eq(pushSubscriptions.id, device.id));
        result.revoked++;
      }
      result.failed++;
      // A fixed label and the error's class: never the endpoint, the keys or the payload.
      console.error("push.send_failed", error instanceof Error ? error.name : "unknown");
    }
  };
  // All of the person's devices at once, inside one overall budget: a slow push service never holds the rest, or the request that sent it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SEND_BUDGET_MS);
  });
  await Promise.race([Promise.allSettled(devices.map(sendTo)), budget]);
  clearTimeout(timer);
  return { status: "done", ...result };
}

export { pushStatus };
