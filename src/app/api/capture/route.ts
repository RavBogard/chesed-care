import { CAPTURE_BODY_MAX, handleCapture } from "@/server/care/shortcut";
import { getDb } from "@/server/db/client";
import { ownerEmails } from "@/server/env";
import { buildClientMeta } from "@/server/meals/client-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

/** The body as text, or null once it passes the cap (a chunked body has no declared length to check first). */
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

/**
 * The iPhone Shortcut. Authenticated by a personal capture token in the Authorization
 * header (never a cookie): see src/server/care/shortcut.ts. Nothing is logged.
 */
export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > CAPTURE_BODY_MAX) return json({ ok: false }, 400);
  const raw = await readCapped(request, CAPTURE_BODY_MAX);
  if (raw === null) return json({ ok: false }, 400);
  const clientKey = buildClientMeta({ headers: request.headers, scope: "capture" })?.clientKey ?? null;
  try {
    const result = await handleCapture({ db: getDb(), authorization: request.headers.get("authorization"), contentType: request.headers.get("content-type"), raw, clientKey, owners: ownerEmails() });
    return json(result.body, result.status, result.status === 401 ? { "www-authenticate": "Bearer" } : {});
  } catch (error) {
    console.error("Capture failed", error instanceof Error ? error.name : "unknown");
    return json({ ok: false }, 500);
  }
}

const notAllowed = () => new Response(null, { status: 405, headers: { allow: "POST" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
