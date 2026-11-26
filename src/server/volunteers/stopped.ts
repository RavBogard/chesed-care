/**
 * People who stopped, or were taken off the roster. When it happens: their "you may ask me again" ticks on volunteer
 * claims and meal sign-ups are turned off, and a salted hash of each contact key is kept (never the contact), so that
 * after the 30-day purge they are still never offered as a past helper or re-added silently. The salt is derived
 * from the app's auth secret, so the table cannot be turned back into contacts without it.
 */
import { createHmac } from "node:crypto";
import { inArray } from "drizzle-orm";
import { corpsStoppedContacts, mealSignups, volunteerClaims } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

function salt(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured");
  return createHmac("sha256", secret).update("mitzvah-corps/stopped-contact/v1").digest();
}

/** The salted hash of a normalised contact key (a lower-case email or the digits of a number). */
export const stoppedHash = (key: string): string => createHmac("sha256", salt()).update(key).digest("base64url");

const keysOf = (m: { emailKey: string | null; mobileKey: string | null }) => [m.emailKey, m.mobileKey].filter((k): k is string => k !== null);

/** Turn off every "ask me again" tick for these contacts and remember that they stopped. */
export async function recordStopped(db: Db, member: { emailKey: string | null; mobileKey: string | null }): Promise<void> {
  const keys = keysOf(member);
  if (keys.length === 0) return;
  await db.update(volunteerClaims).set({ mayAskAgain: false }).where(inArray(volunteerClaims.contactKey, keys));
  await db.update(mealSignups).set({ mayContactAgain: false }).where(inArray(mealSignups.email, keys));
  await db.insert(corpsStoppedContacts).values(keys.map((k) => ({ hash: stoppedHash(k) }))).onConflictDoNothing();
}

/** They are back, with a coordinator's confirmation: forget that they stopped. */
export async function forgetStopped(db: Db, member: { emailKey: string | null; mobileKey: string | null }): Promise<void> {
  const keys = keysOf(member);
  if (keys.length === 0) return;
  await db.delete(corpsStoppedContacts).where(inArray(corpsStoppedContacts.hash, keys.map(stoppedHash)));
}

/** Which of these keys belong to someone who stopped. */
export async function stoppedAmong(db: Db, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.select({ hash: corpsStoppedContacts.hash }).from(corpsStoppedContacts).where(inArray(corpsStoppedContacts.hash, keys.map(stoppedHash)));
  const have = new Set(rows.map((r) => r.hash));
  return new Set(keys.filter((k) => have.has(stoppedHash(k))));
}
