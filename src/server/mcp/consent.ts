import "server-only";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { oauthClient } from "@/server/db/auth-schema";
import type { Db } from "@/server/db/types";
import { plainName, redirectPermitted } from "./oauth-policy";

type Query = Record<string, string | string[] | undefined>;

/**
 * The signed authorization request the OAuth provider put in the consent page's
 * URL, as one string: `sig`, the list of signed parameter names (`ba_param`) and
 * exactly those parameters. Anything else in the URL is dropped. Null: unsigned.
 */
export function signedQuery(query: Query): string | null {
  const all = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) all.append(key, v);
  const names = new Set(all.getAll("ba_param"));
  if (!all.has("sig") || names.size === 0) return null;
  const signed = new URLSearchParams();
  for (const [key, value] of all.entries()) if (key === "sig" || key === "ba_param" || names.has(key)) signed.append(key, value);
  return signed.toString();
}

export type ConsentRequest = { oauthQuery: string; clientName: string; destination: string };

/**
 * What the consent page shows, or null when the request is unsigned, expired,
 * altered, or names a client or redirect this server would not have registered.
 */
export async function describeConsentRequest(db: Db, secret: string, query: Query): Promise<ConsentRequest | null> {
  const oauthQuery = signedQuery(query);
  if (!oauthQuery || !(await verifyOAuthQueryParams(oauthQuery, secret))) return null;
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!clientId || !redirectPermitted(redirectUri)) return null;
  const [client] = await db.select({ name: oauthClient.name, disabled: oauthClient.disabled }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  if (!client || client.disabled) return null;
  return { oauthQuery, clientName: plainName(client.name), destination: new URL(redirectUri).host };
}

/**
 * Where the OAuth provider's consent answer sends the browser (it answers with a
 * JSON body, or a Response carrying one): followed only back to a redirect URI
 * this server permits.
 */
export async function consentRedirect(answer: unknown): Promise<string | null> {
  const body: unknown = answer instanceof Response ? await answer.json().catch(() => null) : answer;
  const url = (body as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return redirectPermitted(`${u.origin}${u.pathname}`) ? url : null;
  } catch {
    return null;
  }
}
