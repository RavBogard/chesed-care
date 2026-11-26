/**
 * Claude connector grants: who is connected, ending a connection, and keeping the
 * token tables small. A connection is its own grant, not tied to a browser
 * session: it ends when it is revoked here, when its person is deactivated or
 * taken off the allowlist, or when its refresh token goes unused for its lifetime.
 * Deleting a token row revokes it (tokens are looked up by hash on every use).
 */
import { and, eq, gt, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { normalizeEmail, type Actor } from "@/server/access/policy";
import { authUser, authVerification, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@/server/db/auth-schema";
import type { Db } from "@/server/db/types";
import { plainName } from "@/server/mcp/oauth-policy";

/** The database, or a transaction on it. */
type Conn = Pick<Db, "select" | "delete" | "update">;

async function authUserIds(db: Conn, email: string): Promise<string[]> {
  const rows = await db.select({ id: authUser.id }).from(authUser).where(sql`lower(${authUser.email}) = ${normalizeEmail(email)}`);
  return rows.map((r) => r.id);
}

/** End every connector grant of the person with this email: access tokens, refresh tokens, remembered consent. */
export async function revokeConnectionsForEmail(db: Conn, email: string): Promise<void> {
  for (const userId of await authUserIds(db, email)) {
    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    await db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    await db.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
  }
}

export type Connection = { clientName: string; connectedAt: Date | null; lastActiveAt: Date };

/** The acting person's own live connections (never anyone else's), newest activity first. */
export async function listOwnConnections(db: Db, actor: Actor, now: Date = new Date()): Promise<Connection[]> {
  const ids = await authUserIds(db, actor.email);
  const byClient = new Map<string, Connection>();
  for (const userId of ids) {
    const rows = await db
      .select({ clientId: oauthClient.clientId, name: oauthClient.name, registeredAt: oauthClient.createdAt, issuedAt: oauthRefreshToken.createdAt })
      .from(oauthRefreshToken)
      .innerJoin(oauthClient, eq(oauthClient.clientId, oauthRefreshToken.clientId))
      .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked), gt(oauthRefreshToken.expiresAt, now)));
    for (const r of rows) {
      const seen = byClient.get(r.clientId);
      // A refresh token is reissued each time Claude renews its access, so its date is the last sign of use.
      if (!seen) byClient.set(r.clientId, { clientName: plainName(r.name), connectedAt: r.registeredAt, lastActiveAt: r.issuedAt });
      else if (r.issuedAt > seen.lastActiveAt) seen.lastActiveAt = r.issuedAt;
    }
  }
  return [...byClient.values()].sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
}

/** Disconnect Claude for the acting person: all of their own tokens and grants, no one else's. */
export async function disconnectOwnConnections(db: Db, actor: Actor): Promise<void> {
  await revokeConnectionsForEmail(db, actor.email);
}

/** Consent is asked on every authorization, so none is ever kept. */
export async function forgetConsents(db: Conn): Promise<void> {
  await db.delete(oauthConsent);
}

/**
 * The OAuth provider records the browser session a token was approved in and
 * would end the token with that session. Connections here are deliberately not
 * tied to a session, so the link is cleared as soon as tokens are issued.
 */
export async function detachTokensFromSessions(db: Conn): Promise<void> {
  await db.update(oauthAccessToken).set({ sessionId: null }).where(isNotNull(oauthAccessToken.sessionId));
  await db.update(oauthRefreshToken).set({ sessionId: null }).where(isNotNull(oauthRefreshToken.sessionId));
}

// Long enough that a person reconnecting with a client Claude registered weeks ago is not cut off mid-flow.
const CLIENT_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Housekeeping, run when a client registers (no cron): drop expired codes and
 * tokens, and clients older than a week that hold no live token.
 */
export async function pruneConnectorRecords(db: Conn, now: Date = new Date()): Promise<void> {
  await db.delete(authVerification).where(lt(authVerification.expiresAt, now));
  await db.delete(oauthAccessToken).where(lt(oauthAccessToken.expiresAt, now));
  await db.delete(oauthRefreshToken).where(lt(oauthRefreshToken.expiresAt, now));
  const liveRefresh = db
    .select({ one: sql`1` })
    .from(oauthRefreshToken)
    .where(and(eq(oauthRefreshToken.clientId, oauthClient.clientId), isNull(oauthRefreshToken.revoked), gt(oauthRefreshToken.expiresAt, now)));
  const liveAccess = db
    .select({ one: sql`1` })
    .from(oauthAccessToken)
    .where(and(eq(oauthAccessToken.clientId, oauthClient.clientId), isNull(oauthAccessToken.revoked), gt(oauthAccessToken.expiresAt, now)));
  await db.delete(oauthClient).where(and(lt(oauthClient.createdAt, new Date(now.getTime() - CLIENT_KEEP_MS)), notExists(liveRefresh), notExists(liveAccess)));
}
