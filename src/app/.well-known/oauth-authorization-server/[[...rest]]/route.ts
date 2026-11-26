import { appOrigin } from "@/server/env";
import { authorizationServerMetadata } from "@/server/mcp/oauth-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public OAuth discovery (RFC 8414) for the connector's authorization server, at
 * the bare path and the issuer-suffixed form (/.well-known/oauth-authorization-server/api/auth).
 * Static: no viewer, no database, nothing private.
 */
export function GET(): Response {
  return new Response(JSON.stringify(authorizationServerMetadata(appOrigin())), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
