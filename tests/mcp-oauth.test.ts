import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "@/server/auth/factory";
import { resolveActor } from "@/server/access/actor";
import { parseOwnerEmails } from "@/server/access/policy";
import { disconnectOwnConnections, listOwnConnections } from "@/server/auth/connections";
import { updateUser } from "@/server/care/users";
import { authSession, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@/server/db/auth-schema";
import { users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { describeConsentRequest } from "@/server/mcp/consent";
import { authorizationServerMetadata, cleanRegistration, redirectPermitted } from "@/server/mcp/oauth-policy";
import { addActor, testDb } from "./support/db";
import { CLAUDE_CALLBACK, connect, form, ORIGIN, pageQuery as query, post, register, RESOURCE, signIn, testAuth, toConsent } from "./support/connector";

// The real OAuth provider, token store and allowlist over PGlite. Only the wiring that
// would reach a real database or environment is replaced; nothing about access is mocked.
const state = vi.hoisted(() => ({ db: null as unknown, auth: null as unknown, cookie: "" }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ getAuth: () => state.auth }));
// The consent form's server action runs outside Next here: its request headers are the test browser's cookie, and a redirect is caught.
vi.mock("next/headers", () => ({ headers: async () => new Headers(state.cookie ? { cookie: state.cookie } : {}) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("redirect"), { url });
  },
}));

import { POST as mcp, GET as mcpGet } from "@/app/api/mcp/route";
import { decideConnectionAction } from "@/app/oauth/consent/actions";
import { GET as resourceMetadataRoute } from "@/app/.well-known/oauth-protected-resource/[[...rest]]/route";
import { GET as serverMetadataRoute } from "@/app/.well-known/oauth-authorization-server/[[...rest]]/route";
import { GET as issuerRelativeMetadataRoute } from "@/app/api/auth/.well-known/oauth-authorization-server/route";

let db: Db;
let auth: Auth;

beforeAll(() => {
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.OWNER_EMAILS = "owner@example.test";
});

beforeEach(async () => {
  db = await testDb();
  auth = testAuth(db);
  state.db = db;
  state.auth = auth;
});

const rpc = (token: string | null, body: unknown = { jsonrpc: "2.0", id: 1, method: "ping" }, headers: Record<string, string> = {}) =>
  mcp(new Request(RESOURCE, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) }));

describe("connector discovery", () => {
  it("protected-resource metadata names the MCP resource and its authorization server", async () => {
    const res = resourceMetadataRoute();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [`${ORIGIN}/api/auth`],
      scopes_supported: ["care", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "CRC Care",
    });
  });

  it("authorization-server metadata offers code + PKCE for public clients, and agrees with the provider itself", async () => {
    const served = (await serverMetadataRoute().json()) as Record<string, unknown>;
    expect(served).toMatchObject({
      issuer: `${ORIGIN}/api/auth`,
      authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
      token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
      registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const provider = (await auth.api.getOAuthServerConfig()) as unknown as Record<string, unknown>;
    for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint", "scopes_supported", "response_types_supported", "grant_types_supported", "code_challenge_methods_supported"]) {
      expect(served[key], key).toEqual(provider[key]);
    }
    expect(served).toEqual(authorizationServerMetadata(ORIGIN));
    // One answer on every discovery path, never the provider's longer list.
    expect(await issuerRelativeMetadataRoute().json()).toEqual(served);
    for (const closed of ["introspection_endpoint", "userinfo_endpoint", "jwks_uri", "end_session_endpoint"]) expect(served[closed], closed).toBeUndefined();
  });

  it("an unauthenticated MCP request is 401 with a challenge pointing at the resource metadata", async () => {
    const res = await rpc(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="care offline_access"`);
    const bad = await rpc("notARealTokenNotARealTokenNotAReal");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(bad.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(mcpGet().status).toBe(405);
  });
});

describe("registration policy", () => {
  it("permits Claude's callbacks and loopback, and nothing that only looks like them", () => {
    for (const ok of [CLAUDE_CALLBACK, "https://claude.com/api/mcp/auth_callback", "http://localhost:54321/callback", "http://127.0.0.1:8976/oauth/callback", "http://localhost/callback"]) {
      expect(redirectPermitted(ok), ok).toBe(true);
    }
    for (const bad of [
      "https://claude.ai.evil.test/api/mcp/auth_callback",
      "https://evil-claude.ai/cb",
      "https://sub.claude.ai/cb",
      "https://claude.ai.:443/cb",
      "https://claude.ai:8443/cb",
      "https://claude.ai:443/cb",
      "https://claude.ai@evil.test/cb",
      "https://evil.test/https://claude.ai/cb",
      "https://claude.ai\\@evil.test/cb",
      "HTTPS://CLAUDE.AI/cb",
      "http://claude.ai/cb",
      "https://localhost/cb",
      "http://localhost.evil.test/cb",
      "http://127.0.0.2:8000/cb",
      "http://127.1/cb",
      "http://[::1]:8000/cb",
      "http://0.0.0.0:8000/cb",
      "claude://callback",
      "javascript:alert(1)",
      "https://claude.ai/cb#fragment",
      "https://claude.ai/cb",
      "https://claude.ai/",
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback?next=https://evil.test",
      "https://claude.ai/api/mcp/auth_callback/../../x",
      "https://claude.com/api/mcp/other",
      "",
      null,
    ]) {
      expect(redirectPermitted(bad), String(bad)).toBe(false);
    }
  });

  it("rebuilds a registration as a public authorization-code client and drops everything else", () => {
    const clean = cleanRegistration({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude <script>", jwks_uri: "https://evil.test/jwks", backchannel_logout_uri: "https://evil.test/out", client_uri: "https://evil.test" });
    expect(clean).toEqual({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude script", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    expect(cleanRegistration({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_basic" })).toBeNull();
    expect(cleanRegistration({ redirect_uris: [CLAUDE_CALLBACK], grant_types: ["authorization_code", "client_credentials"] })).toBeNull();
    expect(cleanRegistration({ redirect_uris: [CLAUDE_CALLBACK, "https://evil.test/cb"] })).toBeNull();
    expect(cleanRegistration({ redirect_uris: [] })).toBeNull();
    expect(cleanRegistration({ redirect_uris: ["https://claude.ai/some/other/page"] })).toBeNull();
    expect(cleanRegistration([{ redirect_uris: [CLAUDE_CALLBACK] }])).toBeNull();
    expect(cleanRegistration({ redirect_uris: [CLAUDE_CALLBACK], scope: "care openid" })).toBeNull();
  });

  it("the endpoint registers Claude and loopback clients as public clients with only the cleaned metadata", async () => {
    const res = await register(auth, [CLAUDE_CALLBACK], { jwks_uri: "https://evil.test/jwks", client_uri: "https://evil.test", post_logout_redirect_uris: ["https://evil.test/out"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe("none");
    const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, String(body.client_id)));
    expect(row).toMatchObject({ redirectUris: [CLAUDE_CALLBACK], tokenEndpointAuthMethod: "none", clientSecret: null, jwksUri: null, uri: null, postLogoutRedirectUris: null, skipConsent: null });
    expect((await register(auth, ["http://127.0.0.1:53111/callback"])).status).toBe(201);
    // Claude registers from its own servers or pages: no cookie, any Origin.
    const fromClaude = await auth.handler(post("/oauth2/register", { client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, { origin: "https://claude.ai" }));
    expect(fromClaude.status).toBe(201);
    expect((await register(auth, ["http://localhost:53111/callback"])).status).toBe(201);
  });

  it("the endpoint refuses look-alike hosts, other schemes, non-default ports and confidential clients", async () => {
    // (Registration is rate limited to five a minute, so four here and one below.)
    for (const uri of ["https://claude.ai.evil.test/cb", "https://claude.ai:8443/cb", "http://claude.ai/cb", "myapp://callback"]) {
      const res = await register(auth, [uri]);
      expect(res.status, uri).toBe(400);
    }
    expect((await register(auth, [CLAUDE_CALLBACK], { token_endpoint_auth_method: "client_secret_post" })).status).toBe(400);
    expect(await db.select().from(oauthClient)).toHaveLength(0);
  });

  it("the provider's other endpoints do not exist here", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    for (const path of ["/oauth2/create-client", "/admin/oauth2/create-client", "/oauth2/continue", "/oauth2/update-consent", "/admin/oauth2/resources"]) {
      expect((await auth.handler(post(path, {}, { cookie, origin: ORIGIN }))).status, path).toBe(404);
    }
    expect((await auth.handler(form("/oauth2/introspect", { token: "x" }))).status).toBe(404);
    for (const path of ["/oauth2/userinfo", "/oauth2/get-clients", "/oauth2/get-consents", "/oauth2/end-session", "/admin/oauth2/resources"]) {
      expect((await auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { headers: { cookie } }))).status, path).toBe(404);
    }
  });
});

describe("connecting as the signed-in person", () => {
  it("authorize sends a signed-out browser to sign-in and a signed-in one to consent; the code needs the PKCE verifier", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const flow = await connect(auth, cookie);
    expect(flow.consentUrl.pathname).toBe("/oauth/consent");
    expect(flow.back.origin + flow.back.pathname).toBe(CLAUDE_CALLBACK);
    expect(flow.back.searchParams.get("state")).toBe("state-1");
    expect(flow.back.searchParams.get("iss")).toBe(`${ORIGIN}/api/auth`);
    expect(flow.tokenResponse.status).toBe(200);
    expect(flow.tokens.token_type).toBe("Bearer");
    expect(flow.tokens.expires_in).toBeLessThanOrEqual(3600);
    expect(flow.tokens.refresh_token).toBeTruthy();
    // Tokens are stored hashed, never as issued.
    const stored = await db.select().from(oauthAccessToken);
    expect(stored).toHaveLength(1);
    expect(stored[0].token).not.toBe(flow.tokens.access_token);
    expect(stored[0].resources).toEqual([RESOURCE]);
    // The code is single-use.
    const again = await auth.handler(form("/oauth2/token", { grant_type: "authorization_code", code: flow.code, client_id: flow.clientId, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: RESOURCE }));
    expect(again.status).toBe(400);

    const signedOut = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: flow.clientId, redirect_uri: CLAUDE_CALLBACK, scope: "care", state: "s", code_challenge: "a".repeat(43), code_challenge_method: "S256", resource: RESOURCE })) signedOut.searchParams.set(k, v);
    const toSignIn = await auth.handler(new Request(signedOut, { headers: { "sec-fetch-mode": "navigate", accept: "text/html" } }));
    expect(new URL(toSignIn.headers.get("location") ?? "", ORIGIN).pathname).toBe("/sign-in");
    // No PKCE challenge: refused back to the client, no consent.
    signedOut.searchParams.delete("code_challenge");
    signedOut.searchParams.delete("code_challenge_method");
    const noPkce = await auth.handler(new Request(signedOut, { headers: { cookie, "sec-fetch-mode": "navigate", accept: "text/html" } }));
    expect(new URL(noPkce.headers.get("location") ?? "", ORIGIN).searchParams.get("error")).toBe("invalid_request");
  });

  it("a wrong PKCE verifier, an unregistered redirect and another resource are refused", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const registered = await register(auth);
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    const authorize = (over: Record<string, string>) => {
      const u = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CALLBACK, scope: "care offline_access", state: "s", code_challenge: "a".repeat(43), code_challenge_method: "S256", resource: RESOURCE, ...over })) u.searchParams.set(k, v);
      return auth.handler(new Request(u, { headers: { cookie, "sec-fetch-mode": "navigate", accept: "text/html" } }));
    };
    const elsewhere = await authorize({ redirect_uri: "https://claude.com/api/mcp/auth_callback" });
    expect(new URL(elsewhere.headers.get("location") ?? "", ORIGIN).pathname).toBe("/not-authorised"); // never to the unregistered URI
    const otherResource = await authorize({ resource: "https://other.example.test/api/mcp" });
    expect(new URL(otherResource.headers.get("location") ?? "", ORIGIN).searchParams.get("error")).toBe("invalid_target");

    const flow = await connect(auth, cookie);
    const wrong = await auth.handler(form("/oauth2/token", { grant_type: "authorization_code", code: "x".repeat(32), client_id: flow.clientId, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: RESOURCE }));
    expect(wrong.status).toBeGreaterThanOrEqual(400);
  });

  it("the consent page describes a signed request and refuses an altered or unsigned one", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const flow = await connect(auth, cookie);
    const secret = (await auth.$context).secret;
    expect(await describeConsentRequest(db, secret, query(flow.consentUrl))).toMatchObject({ clientName: "Claude", destination: "claude.ai" });
    const altered = new URL(flow.consentUrl);
    altered.searchParams.set("redirect_uri", "https://claude.com/api/mcp/auth_callback");
    expect(await describeConsentRequest(db, secret, query(altered))).toBeNull();
    expect(await describeConsentRequest(db, secret, { client_id: flow.clientId, redirect_uri: CLAUDE_CALLBACK })).toBeNull();
    expect(await describeConsentRequest(db, "another-secret-another-secret-another", query(flow.consentUrl))).toBeNull();
  });

  /** Submit the consent form as the browser holding `cookie`; returns where it was sent. */
  async function decide(cookie: string, oauthQuery: string, decision: "allow" | "deny"): Promise<URL> {
    state.cookie = cookie;
    const data = new FormData();
    data.set("oauth_query", oauthQuery);
    data.set("decision", decision);
    const thrown = await decideConnectionAction(data).then(
      () => null,
      (e: { url?: string }) => e,
    );
    return new URL(thrown?.url ?? "", ORIGIN);
  }

  it("the consent form: Allow returns to Claude with a code, Don't allow with access_denied, and only for the signed-in person", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const first = await toConsent(auth, cookie);
    const denied = await decide(cookie, first.oauthQuery, "deny");
    expect(denied.origin + denied.pathname).toBe(CLAUDE_CALLBACK);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("code")).toBeNull();
    expect(await db.select().from(oauthAccessToken)).toHaveLength(0);

    // Signed out, or no longer on the allowlist: nothing is approved.
    expect((await decide("", first.oauthQuery, "allow")).pathname).toBe("/sign-in");
    const cantor = await addActor(db, "cantor@example.test", "clergy");
    const theirs = await signIn(auth, "cantor@example.test");
    await db.update(users).set({ active: false }).where(eq(users.id, cantor.id));
    expect((await decide(theirs.cookie, first.oauthQuery, "allow")).pathname).toBe("/not-authorised");

    // An altered or unsigned request goes nowhere.
    const tampered = first.oauthQuery.replace("claude.ai", "claude.com");
    expect((await decide(cookie, tampered, "allow")).pathname).toBe("/oauth/consent");
    expect((await decide(cookie, "client_id=x&redirect_uri=https%3A%2F%2Fevil.test%2Fcb", "allow")).searchParams.get("expired")).toBe("1");

    const allowed = await decide(cookie, first.oauthQuery, "allow");
    expect(allowed.origin + allowed.pathname).toBe(CLAUDE_CALLBACK);
    expect(allowed.searchParams.get("state")).toBe("state-1");
    const exchanged = await auth.handler(form("/oauth2/token", { grant_type: "authorization_code", code: allowed.searchParams.get("code")!, client_id: first.clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: first.verifier, resource: RESOURCE }));
    expect(exchanged.status).toBe(200);
    const wrongVerifier = await toConsent(auth, cookie);
    const code = (await decide(cookie, wrongVerifier.oauthQuery, "allow")).searchParams.get("code")!;
    const refusedExchange = await auth.handler(form("/oauth2/token", { grant_type: "authorization_code", code, client_id: wrongVerifier.clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: "b".repeat(43), resource: RESOURCE }));
    expect(refusedExchange.status).toBeGreaterThanOrEqual(400);
  });

  it("the access token works on /api/mcp as that person, and refresh rotates", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const { tokens, clientId } = await connect(auth, cookie);
    const ok = await rpc(tokens.access_token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });

    const refreshed = await auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE }));
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await rpc(next.access_token)).status).toBe(200);
    // The old refresh token is spent: replaying it fails and ends the whole grant.
    const replay = await auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE }));
    expect(replay.status).toBe(400);
    expect(await db.select().from(oauthRefreshToken)).toHaveLength(0);
    expect((await rpc(next.access_token)).status).toBe(401);
  });

  it("a token without the MCP resource or a revoked token is refused; a cookie alone is never enough", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const bare = await connect(auth, cookie, { resource: null });
    expect(bare.tokenResponse.status).toBe(200);
    expect((await rpc(bare.tokens.access_token)).status).toBe(401);

    const { tokens, clientId } = await connect(auth, cookie);
    expect((await rpc(tokens.access_token)).status).toBe(200);
    const revoked = await auth.handler(form("/oauth2/revoke", { token: tokens.access_token, token_type_hint: "access_token", client_id: clientId }));
    expect(revoked.status).toBe(200);
    expect((await rpc(tokens.access_token)).status).toBe(401);
    // A revoked refresh token cannot be used either.
    expect((await auth.handler(form("/oauth2/revoke", { token: tokens.refresh_token!, token_type_hint: "refresh_token", client_id: clientId }))).status).toBe(200);
    expect((await auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE }))).status).toBe(400);

    // The signed-in browser's cookie is not a credential for the connector.
    const cookieOnly = await rpc(null, undefined, { cookie });
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("a connection is its own grant: it does not depend on the browser session it was approved in", async () => {
    const { cookie, sessionId } = await signIn(auth, "owner@example.test");
    const { tokens, clientId } = await connect(auth, cookie);
    expect((await db.select().from(oauthAccessToken)).map((t) => t.sessionId)).toEqual([null]);
    expect((await db.select().from(oauthRefreshToken)).map((t) => t.sessionId)).toEqual([null]);
    // Session expired but its row not yet cleaned up, then deleted (sign-out): the same answer either way.
    await db.update(authSession).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authSession.id, sessionId));
    expect((await rpc(tokens.access_token)).status).toBe(200);
    await db.delete(authSession).where(eq(authSession.id, sessionId));
    expect((await rpc(tokens.access_token)).status).toBe(200);
    const refreshed = await auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE }));
    expect(refreshed.status).toBe(200);
    expect((await rpc(((await refreshed.json()) as { access_token: string }).access_token)).status).toBe(200);
  });

  it("consent is asked on every authorization: an approved client gets the page again, and prompt=none never gets a code", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const first = await connect(auth, cookie);
    expect(first.tokenResponse.status).toBe(200);
    expect(await db.select().from(oauthConsent)).toHaveLength(0);
    const authorize = (over: Record<string, string> = {}) => {
      const u = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: first.clientId, redirect_uri: CLAUDE_CALLBACK, scope: "care offline_access", state: "attacker-state", code_challenge: "a".repeat(43), code_challenge_method: "S256", resource: RESOURCE, ...over })) u.searchParams.set(k, v);
      return auth.handler(new Request(u, { headers: { cookie, "sec-fetch-mode": "navigate", accept: "text/html" } }));
    };
    const again = new URL((await authorize()).headers.get("location") ?? "", ORIGIN);
    expect(again.origin + again.pathname).toBe(`${ORIGIN}/oauth/consent`);
    expect(again.searchParams.get("code")).toBeNull();
    const silent = new URL((await authorize({ prompt: "none" })).headers.get("location") ?? "", ORIGIN);
    expect(silent.searchParams.get("code")).toBeNull();
    expect(silent.searchParams.get("error")).toBe("consent_required");
    // Even if an approval were somehow on record, arriving at authorize forgets it first.
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.findUserByEmail("owner@example.test");
    await db.insert(oauthConsent).values({ id: "planted", clientId: first.clientId, userId: user!.user.id, scopes: ["care", "offline_access"], resources: [RESOURCE], createdAt: new Date(), updatedAt: new Date() });
    const planted = new URL((await authorize()).headers.get("location") ?? "", ORIGIN);
    expect(planted.pathname).toBe("/oauth/consent");
    expect(new URL((await authorize({ prompt: "none" })).headers.get("location") ?? "", ORIGIN).searchParams.get("code")).toBeNull();
  });

  it("another site cannot submit the consent endpoint with the person's cookie", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const pending = await toConsent(auth, cookie);
    const forged = await auth.handler(post("/oauth2/consent", { accept: true, oauth_query: pending.oauthQuery }, { cookie, origin: "https://evil.test" }));
    expect(forged.status).toBe(403);
    expect(await db.select().from(oauthAccessToken)).toHaveLength(0);
    expect(await db.select().from(oauthConsent)).toHaveLength(0);
  });

  it("two refreshes at once: exactly one wins", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const { tokens, clientId } = await connect(auth, cookie);
    const refresh = () => auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE }));
    const statuses = (await Promise.all([refresh(), refresh()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
  });

  it("a deactivated or de-allowlisted person: the token is refused with 403 (no refresh loop) and cannot be refreshed", async () => {
    const cantor = await addActor(db, "cantor@example.test", "clergy");
    const { cookie } = await signIn(auth, "cantor@example.test");
    const { tokens, clientId } = await connect(auth, cookie);
    expect((await rpc(tokens.access_token)).status).toBe(200);

    await db.update(users).set({ active: false }).where(eq(users.id, cantor.id));
    const refused = await rpc(tokens.access_token);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBeNull();
    await db.update(users).set({ active: true }).where(eq(users.id, cantor.id));
    expect((await rpc(tokens.access_token)).status).toBe(200);
    await db.delete(users).where(eq(users.id, cantor.id));
    expect((await rpc(tokens.access_token)).status).toBe(403);

    // Refresh re-checks the person, refuses with invalid_grant and ends their grants.
    const refresh = await auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE }));
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe("invalid_grant");
    expect(await db.select().from(oauthRefreshToken)).toHaveLength(0);
    expect(await db.select().from(oauthAccessToken)).toHaveLength(0);
    // Back on the list later: the old tokens stay dead; they connect again.
    await addActor(db, "cantor@example.test", "clergy");
    expect((await rpc(tokens.access_token)).status).toBe(401);
    expect((await auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE }))).status).toBe(400);
  });

  it("deactivating someone in Team ends their connector; Disconnect in Settings ends only one's own", async () => {
    const owner = (await resolveActor(db, { email: "owner@example.test" }, parseOwnerEmails("owner@example.test")))!;
    const cantor = await addActor(db, "cantor@example.test", "clergy");
    const mine = await connect(auth, (await signIn(auth, "owner@example.test")).cookie);
    const theirs = await connect(auth, (await signIn(auth, "cantor@example.test")).cookie);

    expect(await listOwnConnections(db, owner)).toEqual([{ clientName: "Claude", connectedAt: expect.any(Date), lastActiveAt: expect.any(Date) }]);
    expect(await listOwnConnections(db, cantor)).toHaveLength(1);
    expect(await listOwnConnections(db, await addActor(db, "carer@example.test", "caregiver"))).toEqual([]);

    // Disconnect acts on the acting person only.
    await disconnectOwnConnections(db, cantor);
    expect(await listOwnConnections(db, cantor)).toEqual([]);
    expect((await rpc(theirs.tokens.access_token)).status).toBe(401);
    expect((await auth.handler(form("/oauth2/token", { grant_type: "refresh_token", refresh_token: theirs.tokens.refresh_token!, client_id: theirs.clientId, resource: RESOURCE }))).status).toBe(400);
    expect((await rpc(mine.tokens.access_token)).status).toBe(200);
    expect(await listOwnConnections(db, owner)).toHaveLength(1);

    // Team: the owner deactivates the cantor, who had connected again.
    const again = await connect(auth, (await signIn(auth, "cantor@example.test")).cookie);
    expect((await rpc(again.tokens.access_token)).status).toBe(200);
    await updateUser(db, owner, cantor.id, { active: false }, parseOwnerEmails("owner@example.test"));
    expect(await db.select().from(oauthAccessToken)).toHaveLength(1); // the owner's
    expect((await rpc(again.tokens.access_token)).status).toBe(401);
    await updateUser(db, owner, cantor.id, { active: true }, parseOwnerEmails("owner@example.test"));
    expect((await rpc(again.tokens.access_token)).status).toBe(401);
    expect((await rpc(mine.tokens.access_token)).status).toBe(200);
  });

  it("registration is JSON only, and tidies up: expired tokens and idle clients older than 90 days go, live ones stay", async () => {
    expect((await auth.handler(form("/oauth2/register", { redirect_uris: CLAUDE_CALLBACK, token_endpoint_auth_method: "none" }))).status).toBeGreaterThanOrEqual(400);
    expect((await auth.handler(post("/oauth2/register", [{ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }]))).status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(oauthClient)).toHaveLength(0);

    const { cookie } = await signIn(auth, "owner@example.test");
    const live = await connect(auth, cookie);
    const idle = ((await (await register(auth)).json()) as { client_id: string }).client_id;
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await db.update(oauthClient).set({ createdAt: old });
    const expired = { clientId: live.clientId, scopes: ["care"], createdAt: old, expiresAt: new Date(Date.now() - 1000) };
    await db.insert(oauthAccessToken).values({ id: "expired-access", token: "expired-access-hash", ...expired });
    const user = (await (await auth.$context).internalAdapter.findUserByEmail("owner@example.test"))!.user;
    await db.insert(oauthRefreshToken).values({ id: "expired-refresh", token: "expired-refresh-hash", userId: user.id, ...expired });

    const fresh = ((await (await register(auth)).json()) as { client_id: string }).client_id;
    expect((await db.select().from(oauthClient)).map((c) => c.clientId).sort()).toEqual([live.clientId, fresh].sort());
    expect((await db.select().from(oauthClient)).map((c) => c.clientId)).not.toContain(idle);
    expect((await db.select().from(oauthAccessToken)).map((t) => t.id)).not.toContain("expired-access");
    expect((await db.select().from(oauthRefreshToken)).map((t) => t.id)).not.toContain("expired-refresh");
    expect((await rpc(live.tokens.access_token)).status).toBe(200);
  });

  it("an oversized body is refused by its declared length, and a chunked one once it passes the cap", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const { tokens } = await connect(auth, cookie);
    const headers = { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" };
    const declared = await mcp(new Request(RESOURCE, { method: "POST", headers: { ...headers, "content-length": "70000" }, body: "{}" }));
    expect(declared.status).toBe(413);
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 100) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const chunked = await mcp(new Request(RESOURCE, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit));
    expect(chunked.status).toBe(413);
    expect(sent).toBeLessThan(20);
  });

  it("someone who is not on the allowlist cannot get a session to connect with", async () => {
    await expect(signIn(auth, "stranger@example.test")).rejects.toThrow();
  });

  it("a foreign browser origin is refused before anything else", async () => {
    const { cookie } = await signIn(auth, "owner@example.test");
    const { tokens } = await connect(auth, cookie);
    expect((await rpc(tokens.access_token, undefined, { origin: "https://evil.test" })).status).toBe(403);
    expect((await rpc(tokens.access_token, undefined, { origin: "https://claude.ai" })).status).toBe(200);
  });
});
