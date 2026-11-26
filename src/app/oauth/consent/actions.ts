"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/server/auth";
import { getViewer } from "@/server/auth/session";
import { appOrigin } from "@/server/env";
import { consentRedirect } from "@/server/mcp/consent";
import { AUTH_PATH, CONSENT_PATH } from "@/server/mcp/oauth-policy";

/**
 * Allow or deny a connector's request, as the signed-in person. The OAuth provider
 * checks the request's signature and expiry again, records the consent for this
 * person's session, and answers with the redirect back to the client.
 */
export async function decideConnectionAction(form: FormData): Promise<void> {
  const viewer = await getViewer();
  if (viewer.kind === "signed-out") redirect("/sign-in");
  if (viewer.kind === "not-authorised") redirect("/not-authorised");
  const oauthQuery = form.get("oauth_query");
  const accept = form.get("decision") === "allow";
  let target: string | null = null;
  if (typeof oauthQuery === "string" && oauthQuery.length <= 8192) {
    try {
      const requestHeaders = new Headers(await headers());
      const request = new Request(`${appOrigin()}${AUTH_PATH}/oauth2/consent`, { method: "POST", headers: requestHeaders });
      const result: unknown = await getAuth().api.oauth2Consent({ headers: requestHeaders, request, body: { accept, oauth_query: oauthQuery } });
      target = await consentRedirect(result);
    } catch (error) {
      console.error("Connector consent failed", error instanceof Error ? error.name : "unknown");
    }
  }
  redirect(target ?? `${CONSENT_PATH}?expired=1`);
}
