import { createHash, randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { createAuth, type Auth } from "@/server/auth/factory";
import { parseOwnerEmails } from "@/server/access/policy";
import type { Db } from "@/server/db/types";
import { consentRedirect, signedQuery } from "@/server/mcp/consent";

export const ORIGIN = "https://care.example.test";
export const RESOURCE = `${ORIGIN}/api/mcp`;
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** The real auth instance (OAuth provider included) over a test database. */
export function testAuth(db: Db, owners = "owner@example.test"): Auth {
  return createAuth(db, { origin: ORIGIN, secret: randomBytes(32).toString("base64"), google: { clientId: "test", clientSecret: "test" }, ownerEmails: parseOwnerEmails(owners) });
}

/** A signed-in browser for an allowlisted email: the auth user, a session and its cookie header. No Google involved. */
export async function signIn(auth: Auth, email: string): Promise<{ cookie: string; sessionId: string; userId: string }> {
  const ctx = await auth.$context;
  const user = (await ctx.internalAdapter.findUserByEmail(email))?.user ?? (await ctx.internalAdapter.createUser({ email, name: email.split("@")[0], emailVerified: true }, { method: "oauth", oauth: { providerId: "google", profile: {} } }));
  const session = await ctx.internalAdapter.createSession(user.id, false);
  const value = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  return { cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(value)}`, sessionId: session.id, userId: user.id };
}

export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

export const form = (path: string, body: Record<string, string>) =>
  new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

export async function register(auth: Auth, redirectUris: string[] = [CLAUDE_CALLBACK], extra: Record<string, unknown> = {}): Promise<Response> {
  return auth.handler(post("/oauth2/register", { client_name: "Claude", redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...extra }));
}

export type Tokens = { access_token: string; refresh_token?: string; expires_in: number; scope: string; token_type: string };

/**
 * The whole connection, as Claude does it: register, authorize with PKCE as the
 * signed-in person, consent, exchange the code. Returns the tokens and the pieces.
 */
export async function connect(auth: Auth, cookie: string, opts: { redirectUri?: string; resource?: string | null; scope?: string } = {}) {
  const { clientId, verifier, consentUrl, oauthQuery, redirectUri, resource } = await toConsent(auth, cookie, opts);
  const headers = new Headers({ cookie });
  // Exactly what the consent page's server action does (src/app/oauth/consent/actions.ts).
  const consent: unknown = await auth.api.oauth2Consent({ headers, request: new Request(`${ORIGIN}/api/auth/oauth2/consent`, { method: "POST", headers }), body: { accept: true, oauth_query: oauthQuery } });
  const back = new URL((await consentRedirect(consent)) ?? "");
  const code = back.searchParams.get("code") ?? "";
  const tokenBody: Record<string, string> = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier };
  if (resource) tokenBody.resource = resource;
  const tokenResponse = await auth.handler(form("/oauth2/token", tokenBody));
  const tokens = (await tokenResponse.json()) as Tokens;
  return { clientId, verifier, consentUrl, back, code, tokenResponse, tokens, redirectUri };
}

/** Register and authorize as the signed-in person, up to the consent page (nothing approved yet). */
export async function toConsent(auth: Auth, cookie: string, opts: { redirectUri?: string; resource?: string | null; scope?: string } = {}) {
  const redirectUri = opts.redirectUri ?? CLAUDE_CALLBACK;
  const registered = await register(auth, [redirectUri]);
  if (registered.status !== 201) throw new Error(`register ${registered.status}`);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: opts.scope ?? "care offline_access",
    state: "state-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  };
  const resource = opts.resource === undefined ? RESOURCE : opts.resource;
  if (resource) params.resource = resource;
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v);
  const redirected = await auth.handler(new Request(authorize, { headers: { cookie, "sec-fetch-mode": "navigate", accept: "text/html" } }));
  const consentUrl = new URL(redirected.headers.get("location") ?? "", ORIGIN);
  const oauthQuery = signedQuery(pageQuery(consentUrl)) ?? "";
  return { clientId, verifier, consentUrl, oauthQuery, redirectUri, resource };
}

/** A URL's query as a Next.js page receives it (repeated keys as arrays). */
export const pageQuery = (url: URL) => Object.fromEntries([...new Set(url.searchParams.keys())].map((k) => [k, url.searchParams.getAll(k)]));
