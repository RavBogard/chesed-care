/**
 * Personal capture tokens: how the iPhone Shortcut reports a need as the person who
 * made the token. A token is shown once, when made. Only its SHA-256 is stored, with a
 * short visible prefix so a person can tell their tokens apart. It acts as its owner
 * and as no one else: the owner is re-read from the allowlist on every use, so a
 * deactivated or removed person's tokens stop working at once.
 */
import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { canUseCaptureTokens, deny, type Actor } from "@/server/access/policy";
import { captureTokens, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { tokenHash } from "@/server/meals/tokens";
import { writeAudit } from "./audit";
import { InvalidInput, NotFound, uuidOrNotFound } from "./validate";

export const MAX_TOKENS_PER_PERSON = 3;
const PREFIX = "ccap_";
const PREFIX_SHOWN = PREFIX.length + 4;
/** What a presented bearer value must look like before the database is asked about it. */
export const CAPTURE_TOKEN_SHAPE = /^ccap_[A-Za-z0-9_-]{43}$/;

export type CaptureToken = { id: string; prefix: string; createdAt: Date; lastUsedAt: Date | null };

/** The actor's own live tokens, oldest first. Never the secret, which is not kept. */
export async function listCaptureTokens(db: Db, actor: Actor): Promise<CaptureToken[]> {
  if (!canUseCaptureTokens(actor)) deny();
  return db
    .select({ id: captureTokens.id, prefix: captureTokens.prefix, createdAt: captureTokens.createdAt, lastUsedAt: captureTokens.lastUsedAt })
    .from(captureTokens)
    .where(and(eq(captureTokens.userId, actor.id), isNull(captureTokens.revokedAt)))
    .orderBy(asc(captureTokens.createdAt));
}

/** Make a token for the actor. The returned secret is the only time it exists in the clear. */
export async function createCaptureToken(db: Db, actor: Actor): Promise<{ id: string; token: string; prefix: string }> {
  if (!canUseCaptureTokens(actor)) deny();
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return db.transaction(async (tx) => {
    // One person's tokens are counted under a lock on their own row, so two taps cannot make four.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.id)).for("update");
    const live = await tx.select({ id: captureTokens.id }).from(captureTokens).where(and(eq(captureTokens.userId, actor.id), isNull(captureTokens.revokedAt)));
    if (live.length >= MAX_TOKENS_PER_PERSON) throw new InvalidInput("limit");
    const prefix = token.slice(0, PREFIX_SHOWN);
    const [row] = await tx.insert(captureTokens).values({ userId: actor.id, tokenHash: tokenHash(token), prefix }).returning({ id: captureTokens.id });
    await writeAudit(tx, actor, "capture_token.create", "capture_token", row.id);
    return { id: row.id, token, prefix };
  });
}

/** Revoke one of the actor's own tokens. Someone else's id is NotFound, like a missing one. */
export async function revokeCaptureToken(db: Db, actor: Actor, id: unknown, now: Date = new Date()): Promise<void> {
  if (!canUseCaptureTokens(actor)) deny();
  const revoked = await db
    .update(captureTokens)
    .set({ revokedAt: now })
    .where(and(eq(captureTokens.id, uuidOrNotFound(id)), eq(captureTokens.userId, actor.id), isNull(captureTokens.revokedAt)))
    .returning({ id: captureTokens.id });
  if (revoked.length === 0) throw new NotFound();
  await writeAudit(db, actor, "capture_token.revoke", "capture_token", revoked[0].id);
}

/**
 * Who a presented token belongs to: its id and the owner's email, or null for any
 * token that is malformed, unknown or revoked. Whether the
 * owner may still act is decided by the caller from the allowlist.
 */
export async function resolveCaptureToken(db: Db, presented: string): Promise<{ tokenId: string; email: string; name: string | null } | null> {
  if (!CAPTURE_TOKEN_SHAPE.test(presented)) return null;
  const [row] = await db
    .select({ id: captureTokens.id, email: users.email, name: users.name })
    .from(captureTokens)
    .innerJoin(users, eq(users.id, captureTokens.userId))
    .where(and(eq(captureTokens.tokenHash, tokenHash(presented)), isNull(captureTokens.revokedAt)))
    .limit(1);
  return row ? { tokenId: row.id, email: row.email, name: row.name } : null;
}

/** Note a use. Called only once the owner has passed the allowlist check. */
export async function touchCaptureToken(db: Db, tokenId: string, now: Date = new Date()): Promise<void> {
  await db.update(captureTokens).set({ lastUsedAt: now }).where(eq(captureTokens.id, tokenId));
}

/** End every live capture token of a person (they were deactivated). */
export async function revokeAllCaptureTokens(db: Pick<Db, "update">, userId: string, now: Date = new Date()): Promise<void> {
  await db.update(captureTokens).set({ revokedAt: now }).where(and(eq(captureTokens.userId, userId), isNull(captureTokens.revokedAt)));
}
