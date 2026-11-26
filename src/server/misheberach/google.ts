/**
 * Google access for the packet: a service account, with no Google SDK. The JWT is signed with
 * node:crypto (RS256), exchanged at Google's token endpoint for the Docs scope, and the Docs REST
 * API is called with fetch. Nothing here logs a token, a key, a name or a line; failures are
 * errors with fixed names.
 */
import "server-only";
import { createSign } from "node:crypto";
import { buildWriteRequests, describeSection, locateSection, PacketNotConnected, PacketRequestFailed, PacketRevisionConflict, type GoogleDocument, type PacketDoc, type SectionDescription, type SectionEdits, type SectionRead, type SyncMode } from "./packet";

export const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DOCS_URL = "https://docs.googleapis.com/v1/documents";

export type PacketConfig = { docId: string; email: string; key: string };

/** Every call to Google gives up after this long. */
export const FETCH_TIMEOUT_MS = 15_000;
/** A Google Docs document id. */
const DOC_ID = /^[A-Za-z0-9_-]{20,80}$/;

/** MISHEBERACH_SYNC_MODE: off, dry-run or on. With the packet configured and nothing set (or anything else), dry-run. */
export function syncMode(env: Record<string, string | undefined> = process.env): SyncMode {
  if (!packetConfig(env)) return "off";
  const v = env.MISHEBERACH_SYNC_MODE?.trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "dry-run";
}

/** The three settings, or null when any is missing (the packet is then "not connected"). Reads no secret into a message. */
export function packetConfig(env: Record<string, string | undefined> = process.env): PacketConfig | null {
  const docId = env.MISHEBERACH_DOC_ID?.trim();
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const key = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!docId || !email || !key?.trim() || !DOC_ID.test(docId)) return null;
  return { docId, email, key: normalizeKey(key) };
}

/** The address the owner shares the packet with: public, shown in Settings once configured. */
export function serviceAccountEmail(env: Record<string, string | undefined> = process.env): string | null {
  return env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || null;
}

/** A PEM key as it arrives in an environment variable: with real newlines, or with the two characters backslash and n, or wrapped in quotes. */
export function normalizeKey(raw: string): string {
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  return key.replace(/\\r\\n|\\n/g, "\n").trim();
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** The signed assertion Google's token endpoint expects (RS256). */
export function signJwt(config: Pick<PacketConfig, "email" | "key">, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: config.email, scope: DOCS_SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(config.key);
  return `${header}.${claims}.${b64url(signature)}`;
}

type Fetch = typeof fetch;
type Deps = { fetch?: Fetch; now?: () => Date };

const cached = new Map<string, { token: string; until: number }>();

async function accessToken(config: PacketConfig, fetchImpl: Fetch, now: Date): Promise<string> {
  const hit = cached.get(config.email);
  if (hit && hit.until > now.getTime() + 60_000) return hit.token;
  const assertion = signJwt(config, Math.floor(now.getTime() / 1000));
  const res = await fetchImpl(TOKEN_URL, { method: "POST", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  if (!res.ok) throw new PacketRequestFailed();
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new PacketRequestFailed();
  cached.set(config.email, { token: body.access_token, until: now.getTime() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/** Whether a failed batchUpdate says the required revision is no longer the latest. */
async function isRevisionConflict(res: Response): Promise<boolean> {
  if (res.status !== 400 && res.status !== 409 && res.status !== 412) return false;
  try {
    const body = (await res.json()) as { error?: { status?: string; message?: string } };
    return body.error?.status === "FAILED_PRECONDITION" || /revision/i.test(body.error?.message ?? "");
  } catch {
    return false;
  }
}

/** The packet over the Docs REST API. Reads `documents.get`; writes one `documents.batchUpdate` with `requiredRevisionId`. */
export function createGooglePacket(config: PacketConfig | null, deps: Deps = {}): PacketDoc {
  const fetchImpl: Fetch = deps.fetch ?? fetch;
  const clock = deps.now ?? (() => new Date());
  const doc = (): PacketConfig => {
    if (!config) throw new PacketNotConnected();
    return config;
  };
  const get = async (): Promise<GoogleDocument> => {
    const c = doc();
    const token = await accessToken(c, fetchImpl, clock());
    const res = await fetchImpl(`${DOCS_URL}/${encodeURIComponent(c.docId)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new PacketRequestFailed();
    return (await res.json()) as GoogleDocument;
  };
  return {
    async read(): Promise<SectionRead> {
      return locateSection(await get());
    },
    async describe(): Promise<SectionDescription> {
      return describeSection(await get());
    },
    async write(read: SectionRead, edits: SectionEdits): Promise<void> {
      const c = doc();
      // Built (and checked) before anything is sent: a bad batch throws here.
      const requests = buildWriteRequests(read, edits);
      if (requests.length === 0) return;
      const token = await accessToken(c, fetchImpl, clock());
      const res = await fetchImpl(`${DOCS_URL}/${encodeURIComponent(c.docId)}:batchUpdate`, {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ requests, writeControl: { requiredRevisionId: read.revisionId } }),
      });
      if (res.ok) return;
      if (await isRevisionConflict(res)) throw new PacketRevisionConflict();
      throw new PacketRequestFailed();
    },
  };
}

/** The packet as the environment configures it; null when it is not (the list then works on its own). */
export function packetFromEnv(env: Record<string, string | undefined> = process.env): PacketDoc | null {
  const config = packetConfig(env);
  return config && syncMode(env) !== "off" ? createGooglePacket(config) : null;
}
