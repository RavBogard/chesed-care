/**
 * Before the import trusts its "who asked to stop" check, it proves BETTER_AUTH_SECRET is the app's own. With a wrong
 * secret every stopped-contact hash would match nobody and people who asked to stop would come back. So: when any
 * stopped hashes are stored, the contacts still on roster rows are hashed with this secret and at least one must be
 * among them. When none can be checked, the import refuses. Never prints or returns the secret.
 */
import { count } from "drizzle-orm";
import { corpsMembers, corpsStoppedContacts } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { stoppedAmong } from "@/server/volunteers/stopped";

export class SecretUnverified extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnverified";
  }
}

/** Returns how the secret was checked; throws SecretUnverified when it cannot be trusted. */
export async function verifyStopSecret(db: Db): Promise<"no_stopped_contacts" | "matched"> {
  if (!process.env.BETTER_AUTH_SECRET) throw new SecretUnverified("BETTER_AUTH_SECRET is not set.");
  const [{ n }] = await db.select({ n: count() }).from(corpsStoppedContacts);
  // Nobody has ever stopped: there is no one the check could wrongly let back in.
  if (n === 0) return "no_stopped_contacts";
  const keys = (await db.select({ e: corpsMembers.emailKey, m: corpsMembers.mobileKey }).from(corpsMembers)).flatMap((r) => [r.e, r.m]).filter((k): k is string => k !== null);
  if ((await stoppedAmong(db, keys)).size > 0) return "matched";
  throw new SecretUnverified(
    keys.length === 0
      ? "Stopped contacts are stored but no roster contact is left to check BETTER_AUTH_SECRET against. Nothing was written."
      : "BETTER_AUTH_SECRET does not match the stored stopped contacts: it is not the app's secret. Nothing was written.",
  );
}
