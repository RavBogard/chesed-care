import { appOrigin } from "@/server/env";
import { resourceMetadata } from "@/server/mcp/oauth-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public OAuth discovery (RFC 9728) for the connector, at the bare path and the
 * path-suffixed form Claude probes (/.well-known/oauth-protected-resource/api/mcp).
 * Static: no viewer, no database, nothing private.
 */
export function GET(): Response {
  return new Response(JSON.stringify(resourceMetadata(appOrigin())), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
