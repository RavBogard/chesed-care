import "server-only";
import { resolveActor } from "@/server/access/actor";
import type { Actor } from "@/server/access/policy";
import { getDb } from "@/server/db/client";
import { ownerEmails } from "@/server/env";

export type ViewerState = { kind: "signed-out" } | { kind: "not-authorised" } | { kind: "ok"; actor: Actor };

/**
 * From a verified identity (a browser session or a connector token) to the acting
 * user, re-read from the allowlist on every request. The one place both the web
 * app and the connector decide who is acting.
 */
export async function viewerFor(identity: { email: string; name?: string | null } | null): Promise<ViewerState> {
  if (!identity) return { kind: "signed-out" };
  const actor = await resolveActor(getDb(), { email: identity.email, name: identity.name }, ownerEmails());
  return actor ? { kind: "ok", actor } : { kind: "not-authorised" };
}
