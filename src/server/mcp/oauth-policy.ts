/**
 * The connector's OAuth policy: the fixed paths and scopes, and which redirect
 * URIs a dynamically registered client may use. PURE (no database, no
 * environment), so the proxy, the auth factory and tests share one definition.
 */

/** The MCP endpoint; with the origin in front it is also the OAuth resource identifier (RFC 8707). */
export const MCP_PATH = "/api/mcp";
/** better-auth's base path: the OAuth issuer is `<origin>/api/auth`. */
export const AUTH_PATH = "/api/auth";
export const CONSENT_PATH = "/oauth/consent";

/** `care` is the connector itself; `offline_access` is how a client asks for a refresh token. */
export const CARE_SCOPE = "care";
export const OAUTH_SCOPES = [CARE_SCOPE, "offline_access"] as const;

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

const CLAUDE_HOSTS: readonly string[] = ["claude.ai", "claude.com"];
/** Claude's own OAuth callbacks: the only https redirect URIs accepted, matched exactly. */
export const CLAUDE_CALLBACKS: readonly string[] = CLAUDE_HOSTS.map((h) => `https://${h}/api/mcp/auth_callback`);
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

export const mcpResource = (origin: string) => `${origin}${MCP_PATH}`;
export const oauthIssuer = (origin: string) => `${origin}${AUTH_PATH}`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

/**
 * A redirect URI a client may register: exactly one of Claude's callbacks
 * (no other path, no query), or http on localhost / 127.0.0.1 (any port and
 * path: Claude Code and Claude Desktop pick their own). No credentials, no
 * fragment, and a loopback URI must start with the origin it parses to, so
 * nothing that only normalises to an allowed host is accepted.
 */
export function redirectPermitted(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2048 || uri.includes("#")) return false;
  if (CLAUDE_CALLBACKS.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (uri !== u.origin && !uri.startsWith(`${u.origin}/`) && !uri.startsWith(`${u.origin}?`)) return false;
  return u.protocol === "http:" && LOOPBACK_HOSTS.includes(u.hostname);
}

/**
 * CSP `form-action` sources for the consent page only: its Allow / Deny form
 * answers with a redirect to the client's redirect URI, which browsers hold to
 * form-action. The same hosts redirectPermitted allows, nothing wider.
 */
export const CONSENT_FORM_ACTION: readonly string[] = [...CLAUDE_HOSTS.map((h) => `https://${h}`), ...LOOPBACK_HOSTS.map((h) => `http://${h}:*`)];

/** better-auth endpoints of the OAuth provider that this app serves; every other one answers 404. */
export const OAUTH_ENDPOINTS: readonly string[] = ["/oauth2/register", "/oauth2/authorize", "/oauth2/consent", "/oauth2/token", "/oauth2/revoke"];

/** Whether a better-auth route belongs to the OAuth provider plugin (open or closed). */
export function isOAuthProviderPath(path: string): boolean {
  return path.startsWith("/oauth2/") || path.startsWith("/admin/oauth2/");
}

/** RFC 9728 protected-resource metadata for the MCP endpoint. */
export function resourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [oauthIssuer(origin)],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "CRC Care",
  };
}

/**
 * RFC 8414 authorization-server metadata: only what this server offers. Built from
 * the origin alone, so a discovery probe never touches the database; a test holds
 * it equal to what the OAuth provider plugin itself reports.
 */
export function authorizationServerMetadata(origin: string) {
  const issuer = oauthIssuer(origin);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [...GRANTS],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The 401 challenge that points a client at the resource metadata (RFC 9728, RFC 6750). */
export function bearerChallenge(origin: string, invalidToken: boolean): string {
  return `Bearer ${invalidToken ? 'error="invalid_token", ' : ""}resource_metadata="${resourceMetadataUrl(origin)}", scope="${OAUTH_SCOPES.join(" ")}"`;
}

const GRANTS: readonly string[] = ["authorization_code", "refresh_token"];

/**
 * The only registration this server accepts, rebuilt from the request so no
 * other client metadata is stored: a public client (PKCE, no secret) for the
 * authorization-code flow, with permitted redirect URIs. Null: refuse.
 */
export function cleanRegistration(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const redirects = b.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 || !redirects.every(redirectPermitted)) return null;
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") return null;
  const grants = b.grant_types ?? GRANTS;
  if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some((g) => !GRANTS.includes(g))) return null;
  const responses = b.response_types ?? ["code"];
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== "code") return null;
  if (b.application_type !== undefined && b.application_type !== "web" && b.application_type !== "native") return null;
  if (b.scope !== undefined && (typeof b.scope !== "string" || b.scope.split(" ").some((s) => s && !(OAUTH_SCOPES as readonly string[]).includes(s)))) return null;
  return {
    redirect_uris: [...new Set(redirects as string[])],
    client_name: plainName(b.client_name),
    grant_types: [...GRANTS],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(b.application_type !== undefined ? { application_type: b.application_type } : {}),
  };
}

/** A client's self-declared name, safe to show on the consent page. */
export function plainName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/[^\p{L}\p{N} .'()-]/gu, "").trim().slice(0, 60) : "";
  return name || "Claude";
}
