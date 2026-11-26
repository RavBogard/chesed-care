import { eq } from "drizzle-orm";
import { users } from "@/server/db/schema";
import { userColumns } from "@/server/db/user-columns";
import type { Db } from "@/server/db/types";
import { decideAccess, normalizeEmail, type Actor } from "./policy";

/**
 * Turn a verified sign-in identity into the acting user, or null when the email is
 * not allowed. An OWNER_EMAILS address gets (or keeps) an active owner row.
 */
export async function resolveActor(db: Db, identity: { email: string; name?: string | null }, ownerEmails: ReadonlySet<string>): Promise<Actor | null> {
  const email = normalizeEmail(identity.email);
  if (!email) return null;
  const [row] = await db.select(userColumns).from(users).where(eq(users.email, email)).limit(1);
  const decision = decideAccess(email, ownerEmails, row ?? null);
  if (decision.kind === "denied") return null;
  if (decision.kind === "member") return { id: decision.userId, email, name: row!.name, role: decision.role };
  const name = row?.name ?? identity.name ?? null;
  // An existing row is updated, never re-inserted: an insert names every column, so this stays safe before a new column has been migrated.
  if (row) {
    const [kept] = await db.update(users).set({ role: "owner", active: true, name }).where(eq(users.id, row.id)).returning(userColumns);
    return { id: kept.id, email, name: kept.name, role: "owner" };
  }
  const [owner] = await db
    .insert(users)
    .values({ email, name, role: "owner", active: true })
    .onConflictDoUpdate({ target: users.email, set: { role: "owner", active: true, name } })
    .returning(userColumns);
  return { id: owner.id, email, name: owner.name, role: "owner" };
}

/** Whether an email may sign in at all (used by the auth hooks before any session exists). */
export async function isEmailAllowed(db: Db, email: string, ownerEmails: ReadonlySet<string>): Promise<boolean> {
  const e = normalizeEmail(email);
  const [row] = await db.select({ id: users.id, role: users.role, active: users.active }).from(users).where(eq(users.email, e)).limit(1);
  return decideAccess(e, ownerEmails, row ?? null).kind !== "denied";
}
