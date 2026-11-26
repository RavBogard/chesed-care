import { GET as serverMetadata } from "@/app/.well-known/oauth-authorization-server/[[...rest]]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The same document at the issuer-relative path some clients try
 * (<issuer>/.well-known/oauth-authorization-server), so every discovery path
 * gives one answer: only what this server offers. Without this file the OAuth
 * provider plugin would answer here itself, listing endpoints this app closes.
 */
export function GET(): Response {
  return serverMetadata();
}
