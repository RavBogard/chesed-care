import "server-only";
import { demoEmail, isDemo } from "@/lib/demo";
import { parseOwnerEmails } from "@/server/access/policy";

/** Read a required variable; the error names the variable, never its value. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

export function authEnv() {
  return {
    origin: new URL(required("BETTER_AUTH_URL")).origin,
    secret: required("BETTER_AUTH_SECRET"),
    google: { clientId: required("GOOGLE_CLIENT_ID"), clientSecret: required("GOOGLE_CLIENT_SECRET") },
    ownerEmails: parseOwnerEmails(process.env.OWNER_EMAILS),
  };
}

export function ownerEmails() {
  // The demo's senior rabbi is its owner; OWNER_EMAILS is not read.
  if (isDemo()) return parseOwnerEmails(demoEmail("rabbi"));
  return parseOwnerEmails(process.env.OWNER_EMAILS);
}

/** The app's public origin (no path), for the connector's metadata. Reads no secret. */
export function appOrigin(): string {
  return new URL(required("BETTER_AUTH_URL")).origin;
}
