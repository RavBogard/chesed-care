import "server-only";
import { viewerFor, type ViewerState } from "@/server/auth/viewer";
import { resolveConnectorToken } from "./token";

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]{16,512}=*)$/;

/**
 * Who is making this MCP request. The bearer token only says which sign-in
 * identity it was issued to; the acting user is then re-read from the allowlist
 * exactly as for a browser request (viewerFor), so a removed or deactivated
 * person is refused on their next call even with a live token.
 */
export async function getConnectorViewer(request: Request): Promise<ViewerState> {
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!match) return { kind: "signed-out" };
  return viewerFor(await resolveConnectorToken(match[1]));
}
