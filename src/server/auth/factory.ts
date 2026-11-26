import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getOAuthProviderApi, oauthProvider } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isEmailAllowed } from "@/server/access/actor";
import { authModels, authUser, oauthRefreshToken } from "@/server/db/auth-schema";
import type { Db } from "@/server/db/types";
import { detachTokensFromSessions, forgetConsents, pruneConnectorRecords, revokeConnectionsForEmail } from "./connections";
import {
  ACCESS_TOKEN_SECONDS,
  CARE_SCOPE,
  cleanRegistration,
  CONSENT_PATH,
  isOAuthProviderPath,
  mcpResource,
  OAUTH_ENDPOINTS,
  OAUTH_SCOPES,
  REFRESH_TOKEN_SECONDS,
} from "@/server/mcp/oauth-policy";

export type AuthConfig = {
  origin: string;
  secret: string;
  google: { clientId: string; clientSecret: string };
  ownerEmails: ReadonlySet<string>;
};

/** Who a connector token belongs to: the verified sign-in identity, never an access decision. */
export type ConnectorIdentity = { email: string; name: string | null };

/**
 * The Claude connector's OAuth 2.1 authorization server (@better-auth/oauth-provider),
 * narrowed to what the connector needs: public clients registered dynamically by
 * Claude, authorization code + PKCE (S256), consent by the signed-in user, opaque
 * access tokens (stored hashed, so they can be revoked) and rotating refresh tokens.
 * No OIDC, no client credentials, no JWTs.
 *
 * The refresh lifetime is rolling: each use issues a new refresh token good for
 * REFRESH_TOKEN_SECONDS. The plugin has no absolute cap on a grant's age.
 */
function connectorProvider(resource: string) {
  return oauthProvider({
    loginPage: "/sign-in",
    consentPage: CONSENT_PATH,
    scopes: [...OAUTH_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    disableJwtPlugin: true,
    storeTokens: "hashed",
    accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
    codeExpiresIn: 5 * 60,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Loopback redirect URIs (Claude Code, Claude Desktop) register as native clients.
    clientRegistrationDefaultApplicationType: "infer",
    // The one resource tokens are issued for; every registered client is linked to it.
    resources: [{ identifier: resource, name: "CRC Care connector", allowedScopes: [...OAUTH_SCOPES] }],
    clientRegistrationDefaultResources: [resource],
    // Resources are fixed in code: the plugin's resource admin endpoints refuse everyone
    // (they are also outside OAUTH_ENDPOINTS, so they answer 404 before this is asked).
    resourcePrivileges: () => false,
  });
}

/**
 * Server-only (no URL): resolve a connector access token to the identity it was
 * issued to. The token must be active, issued for this app's MCP resource and
 * carry the `care` scope. Null for anything else.
 */
function connectorTokens(provider: ReturnType<typeof oauthProvider>, resource: string) {
  return {
    id: "care-connector-tokens",
    endpoints: {
      resolveConnectorToken: createAuthEndpoint.serverOnly({ method: "POST", body: z.object({ token: z.string().min(1).max(512) }) }, async (ctx): Promise<ConnectorIdentity | null> => {
        let payload: Record<string, unknown>;
        try {
          payload = (await getOAuthProviderApi(ctx, provider.options).requireActiveAccessToken(ctx.body.token)) as Record<string, unknown>;
        } catch (error) {
          // Unknown, expired or revoked: not an identity. Anything else (the database) is a real failure.
          if (isAPIError(error)) return null;
          throw error;
        }
        const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
        if (payload.active !== true || !audience.includes(resource) || !scopes.includes(CARE_SCOPE) || typeof payload.sub !== "string") return null;
        const user = await ctx.context.internalAdapter.findUserById(payload.sub);
        if (!user || user.emailVerified !== true) return null;
        return { email: user.email, name: user.name ?? null };
      }),
    },
  };
}

/**
 * better-auth with Google sign-in only (basic profile: openid, email, profile).
 * No environment access here; the caller supplies validated config.
 *
 * The allowlist is enforced twice: no auth user is created and no session is
 * issued for an email that is not allowed (hooks below), and every request
 * re-resolves the acting user (src/server/auth/session.ts for the web,
 * src/server/mcp/viewer.ts for the connector), so deactivating a user takes
 * effect on their next request, whatever session or token they still hold.
 */
export function createAuth(db: Db, config: AuthConfig) {
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin) throw new Error("Auth origin must be a bare origin");
  const resource = mcpResource(config.origin);
  const provider = connectorProvider(resource);

  /**
   * A refresh is refused unless its person may still use the app: someone
   * deactivated or taken off the allowlist cannot renew, and their grants end.
   * An unknown token is left for the provider to refuse.
   */
  async function refuseRefreshForRemovedPerson(ctx: Parameters<typeof getOAuthProviderApi>[0], refreshToken: unknown): Promise<void> {
    if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 512) return;
    const hash = await getOAuthProviderApi(ctx, provider.options).hashToken(refreshToken, "refresh_token");
    const [row] = await db
      .select({ email: authUser.email, verified: authUser.emailVerified })
      .from(oauthRefreshToken)
      .innerJoin(authUser, eq(authUser.id, oauthRefreshToken.userId))
      .where(eq(oauthRefreshToken.token, hash))
      .limit(1);
    if (!row || (row.verified && (await isEmailAllowed(db, row.email, config.ownerEmails)))) return;
    await revokeConnectionsForEmail(db, row.email);
    throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "This connection has ended." });
  }

  return betterAuth({
    appName: "CRC Care",
    baseURL: config.origin,
    secret: config.secret,
    trustedOrigins: [config.origin],
    database: drizzleAdapter(db, { provider: "pg", schema: authModels }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret, prompt: "select_account" },
    },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
    session: { expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    // Stated, not left to the library default (which switches both checks off under a test runner): a request
    // carrying the cookie must come from this origin. The consent endpoint depends on it.
    advanced: { useSecureCookies: origin.protocol === "https:", disableOriginCheck: false, disableCSRFCheck: false },
    onAPIError: { errorURL: "/not-authorised" },
    // Library diagnostics can carry identities or tokens; keep them out of logs.
    logger: { disabled: true },
    plugins: [provider, connectorTokens(provider, resource)],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const path = ctx.path;
        if (typeof path !== "string" || !isOAuthProviderPath(path)) return;
        // A closed list: the plugin's other endpoints (client and consent management,
        // introspection, userinfo, end-session) do not exist here.
        if (!OAUTH_ENDPOINTS.includes(path)) throw new APIError("NOT_FOUND");
        // Consent is asked on every authorization. The provider would remember an approval and skip the
        // page next time, so whenever a browser arrives at authorize nothing remembered is left. (The
        // provider also runs authorize internally, after sign-in and after Allow: those are other requests.)
        if (path === "/oauth2/authorize" && ctx.request && new URL(ctx.request.url).pathname.endsWith("/oauth2/authorize")) await forgetConsents(db);
        if (path === "/oauth2/token" && (ctx.body as Record<string, unknown> | undefined)?.grant_type === "refresh_token") {
          await refuseRefreshForRemovedPerson(ctx as unknown as Parameters<typeof getOAuthProviderApi>[0], (ctx.body as Record<string, unknown>).refresh_token);
        }
        if (path === "/oauth2/register") {
          const clean = cleanRegistration(ctx.body);
          if (!clean) throw new APIError("BAD_REQUEST", { error: "invalid_client_metadata", error_description: "This server registers only Claude's public clients." });
          // Replace the request's metadata in place, so only the cleaned fields reach the plugin.
          const body = ctx.body as Record<string, unknown>;
          for (const key of Object.keys(body)) delete body[key];
          Object.assign(body, clean);
          // Housekeeping rides on registration (rate limited, and rare): no scheduled job.
          await pruneConnectorRecords(db).catch((error) => console.error("Connector pruning failed", error instanceof Error ? error.name : "unknown"));
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // A connection is its own grant, not tied to the browser session it was approved in.
        if (ctx.path === "/oauth2/token") await detachTokensFromSessions(db);
        if (ctx.path === "/oauth2/consent") await forgetConsents(db);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Google must vouch for the address, and it must be on the allowlist.
          before: async (user) => (user.emailVerified === true && (await isEmailAllowed(db, user.email, config.ownerEmails)) ? undefined : false),
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [u] = await db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, session.userId)).limit(1);
            return u && (await isEmailAllowed(db, u.email, config.ownerEmails)) ? undefined : false;
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
