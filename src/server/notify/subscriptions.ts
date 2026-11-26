/**
 * A person's devices. Everything here acts on the signed-in person's OWN rows only: ids from the
 * browser are matched together with the actor's id, so another person's device is never found.
 * The endpoint and keys are secrets of the push service and are never returned to a screen or logged.
 */
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { canSetNotifications, deny, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { InvalidInput, NotFound, uuidOrNotFound } from "@/server/care/validate";
import { pushSubscriptions } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

export const MAX_DEVICES = 6;
/** A subscription revoked this long ago is deleted by the daily job. */
export const REVOKED_KEEP_DAYS = 30;

export const DEVICE_LABELS = ["iPhone", "Android phone", "Mac", "Windows PC", "Other"] as const;
export type DeviceLabel = (typeof DEVICE_LABELS)[number];

/** A broad label from the browser's user-agent text, and nothing more. Pure. */
export function deviceLabel(userAgent: string | null | undefined): DeviceLabel {
  const ua = userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android phone";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  return "Other";
}

/** The push services a browser subscribes through. A subscription to any other host is refused, so the server can never be made to call an arbitrary address. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

/** A browser's P-256 public key is 65 bytes (87 base64url characters) and its auth secret 16 bytes (22): anything else is not a subscription. */
const P256DH = /^[A-Za-z0-9_-]{87}$/;
const AUTH = /^[A-Za-z0-9_-]{22}$/;

export type SubscribeInput = { endpoint: unknown; p256dh: unknown; auth: unknown; userAgent?: string | null };

/**
 * Turn notifications on for this device. Re-subscribing the same browser updates it. A seventh device is refused (the count is
 * made under a lock on the person's row, so two at once cannot both get in). An address that is on someone else's device is never
 * moved to the actor: it fails plainly (a device that person turned off is free to take).
 */
export async function subscribeDevice(db: Db, actor: Actor, input: SubscribeInput): Promise<{ id: string; deviceLabel: DeviceLabel }> {
  if (!canSetNotifications(actor)) deny();
  if (!isPushEndpoint(input.endpoint)) throw new InvalidInput("endpoint");
  if (typeof input.p256dh !== "string" || !P256DH.test(input.p256dh)) throw new InvalidInput("p256dh");
  if (typeof input.auth !== "string" || !AUTH.test(input.auth)) throw new InvalidInput("auth");
  const { endpoint, p256dh, auth } = { endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth };
  const label = deviceLabel(input.userAgent);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${actor.id} for update`);
    const [existing] = await tx.select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId, revokedAt: pushSubscriptions.revokedAt }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).limit(1);
    if (existing && existing.userId !== actor.id && existing.revokedAt === null) throw new InvalidInput("endpoint");
    const already = existing !== undefined && existing.userId === actor.id && existing.revokedAt === null;
    if (!already) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, actor.id), isNull(pushSubscriptions.revokedAt)));
      if (n >= MAX_DEVICES) throw new InvalidInput("devices");
    }
    const values = { userId: actor.id, endpoint, p256dh, auth, deviceLabel: label, failureCount: 0, revokedAt: null };
    const [row] = await tx
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values, setWhere: or(eq(pushSubscriptions.userId, actor.id), isNotNull(pushSubscriptions.revokedAt)) })
      .returning({ id: pushSubscriptions.id });
    if (!row) throw new InvalidInput("endpoint");
    if (!already) await writeAudit(tx, actor, "push_device.add", "push_device", row.id);
    return { id: row.id, deviceLabel: label };
  });
}

export type DeviceView = { id: string; deviceLabel: string; createdAt: Date; lastSuccessAt: Date | null };

/** The actor's own devices that are on. No endpoint, no keys. */
export async function listDevices(db: Db, actor: Actor): Promise<DeviceView[]> {
  if (!canSetNotifications(actor)) deny();
  return db
    .select({ id: pushSubscriptions.id, deviceLabel: pushSubscriptions.deviceLabel, createdAt: pushSubscriptions.createdAt, lastSuccessAt: pushSubscriptions.lastSuccessAt })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, actor.id), isNull(pushSubscriptions.revokedAt)))
    .orderBy(asc(pushSubscriptions.createdAt));
}

/** Turn one of the actor's own devices off. Another person's device is "not found". */
export async function removeDevice(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<void> {
  if (!canSetNotifications(actor)) deny();
  const done = await db
    .update(pushSubscriptions)
    .set({ revokedAt: now })
    .where(and(eq(pushSubscriptions.id, uuidOrNotFound(id)), eq(pushSubscriptions.userId, actor.id), isNull(pushSubscriptions.revokedAt)))
    .returning({ id: pushSubscriptions.id });
  if (done.length === 0) throw new NotFound();
  await writeAudit(db, actor, "push_device.remove", "push_device", done[0].id);
}

/** Turn off the device this browser is, by its own endpoint (only ever the actor's own row). Quietly does nothing when there is none. */
export async function removeDeviceByEndpoint(db: Db, actor: Actor, endpoint: unknown, now: Date = new Date()): Promise<void> {
  if (!canSetNotifications(actor)) deny();
  if (!isPushEndpoint(endpoint)) throw new InvalidInput("endpoint");
  const done = await db
    .update(pushSubscriptions)
    .set({ revokedAt: now })
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, actor.id), isNull(pushSubscriptions.revokedAt)))
    .returning({ id: pushSubscriptions.id });
  for (const { id } of done) await writeAudit(db, actor, "push_device.remove", "push_device", id);
}

/** Daily job: delete subscriptions revoked more than 30 days ago. */
export async function purgeRevoked(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - REVOKED_KEEP_DAYS * 86_400_000);
  const gone = await db.delete(pushSubscriptions).where(lt(pushSubscriptions.revokedAt, cutoff)).returning({ id: pushSubscriptions.id });
  return gone.length;
}
