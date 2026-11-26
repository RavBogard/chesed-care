/**
 * A slim, read-only Salesforce client: OAuth 2.0 JWT bearer sign-in (the same
 * connected app and env variables as MavenAI's service account) and `query(soql)`.
 * There is deliberately no other method: nothing in this app can write to Salesforce.
 */
import { createSign } from "node:crypto";
import { assertReadOnlySoql } from "./soql-guard";

export const SF_API_VERSION = "v62.0";
const TIMEOUT_MS = 20_000;
const TOKEN_LIFETIME_MS = 90 * 60_000;
const MAX_RECORDS = 50_000;

export type SfRow = Record<string, unknown>;
export type SalesforceClient = { query(soql: string): Promise<SfRow[]> };

export type SalesforceConfig = {
  consumerKey: string;
  username: string;
  /** PEM, or the PEM base64-encoded (how MavenAI stores SF_JWT_PRIVATE_KEY). */
  privateKey: string;
  /** Login host, e.g. https://login.salesforce.com. */
  audience: string;
  /** Used when the token response carries no instance_url. */
  instanceUrl?: string;
};

export class SalesforceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SalesforceError";
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemOf(key: string): string {
  if (key.includes("PRIVATE KEY")) return key;
  const decoded = Buffer.from(key, "base64").toString("utf8");
  return decoded.includes("PRIVATE KEY") ? decoded : key;
}

/** iss = consumer key, sub = run-as username, aud = login host, exp = now + 3 minutes. */
export function buildJwtAssertion(config: SalesforceConfig, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: config.consumerKey, sub: config.username, aud: config.audience, exp: Math.floor(nowMs / 1000) + 180 }));
  const input = `${header}.${claims}`;
  return `${input}.${base64url(createSign("RSA-SHA256").update(input).sign(pemOf(config.privateKey)))}`;
}

export function createSalesforceClient(config: SalesforceConfig, deps: { fetch?: typeof fetch; now?: () => number } = {}): SalesforceClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let token: { accessToken: string; instanceUrl: string; expiresAt: number } | null = null;

  async function signIn() {
    const res = await doFetch(`${config.audience}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: buildJwtAssertion(config, now()) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) throw new SalesforceError("Salesforce sign-in failed", res.status);
    const data = (await res.json()) as { access_token?: string; instance_url?: string };
    const instanceUrl = data.instance_url || config.instanceUrl;
    if (!data.access_token || !instanceUrl) throw new SalesforceError("Salesforce sign-in returned no token");
    token = { accessToken: data.access_token, instanceUrl: new URL(instanceUrl).origin, expiresAt: now() + TOKEN_LIFETIME_MS };
    return token;
  }

  async function get(path: string): Promise<{ records?: SfRow[]; done?: boolean; nextRecordsUrl?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = token && token.expiresAt > now() ? token : await signIn();
      const res = await doFetch(`${t.instanceUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${t.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (!res.ok) throw new SalesforceError("Salesforce query failed", res.status);
      return (await res.json()) as { records?: SfRow[]; done?: boolean; nextRecordsUrl?: string };
    }
    throw new SalesforceError("Salesforce rejected the session", 401);
  }

  return {
    async query(soql: string): Promise<SfRow[]> {
      const q = assertReadOnlySoql(soql);
      const out: SfRow[] = [];
      let page = await get(`/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(q)}`);
      for (;;) {
        out.push(...(page.records ?? []).map(stripAttributes));
        if (page.done !== false || !page.nextRecordsUrl) break;
        if (out.length >= MAX_RECORDS) throw new SalesforceError("Salesforce result too large");
        // Only follow a same-API query cursor, never an arbitrary URL.
        if (!/^\/services\/data\/v\d+\.\d+\/query\/[A-Za-z0-9-]+$/.test(page.nextRecordsUrl)) throw new SalesforceError("Unexpected Salesforce cursor");
        page = await get(page.nextRecordsUrl);
      }
      return out;
    },
  };
}

/** Drop Salesforce's `attributes` metadata, recursively through relationship objects. */
function stripAttributes(row: SfRow): SfRow {
  const out: SfRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "attributes") continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? stripAttributes(v as SfRow) : v;
  }
  return out;
}
