/**
 * A person's notification choices: which kinds are on (only what they changed is stored; the rest
 * follows the default for their role) and their quiet hours (America/Chicago). Own row only.
 */
import { eq } from "drizzle-orm";
import { PREF_KINDS, type PrefKind } from "@/lib/notice";
import { canSetNotifications, deny, noticeDefaultOn, noticeKindsFor, type Actor } from "@/server/access/policy";
import { InvalidInput } from "@/server/care/validate";
import { notificationPrefs } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CONGREGATION_TZ } from "@/server/lifecycle/window";

export type Prefs = { kinds: Partial<Record<PrefKind, boolean>>; quietEnabled: boolean; quietStartHour: number; quietEndHour: number; urgentIgnoresQuiet: boolean };

export const DEFAULT_PREFS: Prefs = { kinds: {}, quietEnabled: true, quietStartHour: 21, quietEndHour: 7, urgentIgnoresQuiet: true };

/** Only known kinds with a true/false value survive; anything else in the stored JSON is dropped. */
export function storedKinds(value: unknown): Partial<Record<PrefKind, boolean>> {
  const out: Partial<Record<PrefKind, boolean>> = {};
  if (value && typeof value === "object") for (const k of PREF_KINDS) if (typeof (value as Record<string, unknown>)[k] === "boolean") out[k] = (value as Record<string, boolean>)[k];
  return out;
}

export async function loadPrefs(db: Db, userId: string): Promise<Prefs> {
  const [row] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)).limit(1);
  if (!row) return DEFAULT_PREFS;
  return { kinds: storedKinds(row.kinds), quietEnabled: row.quietEnabled, quietStartHour: row.quietStartHour, quietEndHour: row.quietEndHour, urgentIgnoresQuiet: row.urgentIgnoresQuiet };
}

/** The hour of day (0 to 23) in Chicago. */
export function chicagoHour(now: Date): number {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: CONGREGATION_TZ, hour: "numeric", hourCycle: "h23" }).format(now));
  return hour % 24;
}

/** Whether `hour` is inside quiet hours that run from `start` to `end` (they may wrap midnight). Pure. */
export function hourIsQuiet(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function isQuiet(prefs: Prefs, now: Date): boolean {
  return prefs.quietEnabled && hourIsQuiet(chicagoHour(now), prefs.quietStartHour, prefs.quietEndHour);
}

/** What the screen shows for each switch: the choice, or the role's default when none was made. */
export function effectiveKinds(actor: Actor, prefs: Prefs): { kind: PrefKind; on: boolean }[] {
  return noticeKindsFor(actor).map((kind) => ({ kind, on: prefs.kinds[kind] ?? noticeDefaultOn(actor.role, kind) }));
}

const hour = (v: unknown, field: string): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 23) throw new InvalidInput(field);
  return n;
};

export type PrefsInput = { kinds: Partial<Record<string, unknown>>; quietEnabled: unknown; quietStartHour: unknown; quietEndHour: unknown; urgentIgnoresQuiet: unknown };

/** Save the actor's own choices. Only the kinds that could reach their role are stored. */
export async function savePrefs(db: Db, actor: Actor, input: PrefsInput): Promise<Prefs> {
  if (!canSetNotifications(actor)) deny();
  const kinds: Partial<Record<PrefKind, boolean>> = {};
  for (const kind of noticeKindsFor(actor)) {
    const v = input.kinds[kind];
    if (typeof v !== "boolean") throw new InvalidInput(kind);
    kinds[kind] = v;
  }
  const next: Prefs = {
    kinds,
    quietEnabled: input.quietEnabled === true,
    quietStartHour: hour(input.quietStartHour, "quietStartHour"),
    quietEndHour: hour(input.quietEndHour, "quietEndHour"),
    urgentIgnoresQuiet: input.urgentIgnoresQuiet === true,
  };
  await db.insert(notificationPrefs).values({ userId: actor.id, ...next }).onConflictDoUpdate({ target: notificationPrefs.userId, set: next });
  return next;
}
