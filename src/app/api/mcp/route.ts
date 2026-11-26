import { getDb } from "@/server/db/client";
import { appOrigin } from "@/server/env";
import { bearerChallenge } from "@/server/mcp/oauth-policy";
import { answerRpc, protocolHeaderAccepted, SUPPORTED_VERSIONS } from "@/server/mcp/transport";
import { getConnectorViewer } from "@/server/mcp/viewer";
import { getSalesforce } from "@/server/salesforce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
// A browser page may not call this endpoint: an Origin, when sent, must be ours or Claude's.
const CLAUDE_ORIGINS = ["https://claude.ai", "https://claude.com"];

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}
const refuse = (status: number, message: string, extra?: Record<string, string>) => json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }, status, extra);

/** The request body as text, or null once it passes the cap (a chunked body has no declared length to check first). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The Claude connector: one JSON-RPC request per POST, as the person the bearer token belongs to. */
export async function POST(request: Request): Promise<Response> {
  const origin = appOrigin();
  const from = request.headers.get("origin");
  if (from !== null && from !== origin && !CLAUDE_ORIGINS.includes(from)) return refuse(403, "Forbidden");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return refuse(413, "Request too large");

  // Only the bearer token counts (never a cookie), and the acting user is re-read from the allowlist on every request.
  const viewer = await getConnectorViewer(request);
  if (viewer.kind === "signed-out") {
    return json({ error: "invalid_token" }, 401, { "www-authenticate": bearerChallenge(origin, request.headers.has("authorization")) });
  }
  // A good token whose person was deactivated or taken off the allowlist: refused outright. Not a 401,
  // which would send the client to refresh or sign in again for an answer that cannot change.
  if (viewer.kind === "not-authorised") return refuse(403, "This account no longer has access to CRC Care.");

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return refuse(413, "Request too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const version = request.headers.get("mcp-protocol-version");
  const initialize = !!body && typeof body === "object" && (body as Record<string, unknown>).method === "initialize";
  if (version !== null && !initialize && !protocolHeaderAccepted(version)) {
    return refuse(400, `Unsupported MCP-Protocol-Version (supported: ${SUPPORTED_VERSIONS.join(", ")} or later).`);
  }

  const reply = await answerRpc(body, { db: getDb(), sf: getSalesforce, now: new Date(), actor: viewer.actor });
  return reply ? json(reply, 200) : new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}

const notAllowed = () => new Response(null, { status: 405, headers: { allow: "POST" } });
// Stateless: there is no stream to open and no session to end.
export const GET = notAllowed;
export const DELETE = notAllowed;
