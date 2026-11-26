/**
 * What the public (no account) form actions share: reading a field, building clientMeta on the
 * server, and the refusals every secret-link action returns. Nothing here logs a value:
 * only a fixed label and the error's name.
 */
import { headers } from "next/headers";
import type { ActionState } from "@/lib/action-state";
import { buildClientMeta } from "@/server/meals/client-meta";

/** A form field as a string; a file or a missing field is the empty string. */
export const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** clientMeta from the platform's address, the honeypot and (when `timed`) the server-signed render stamp. */
export async function clientMeta(scope: string, form: FormData, timed: boolean) {
  return buildClientMeta({ headers: await headers(), scope, stamp: timed ? text(form, "stamp") : undefined, honeypot: text(form, "website") });
}

/** The refusals of one public side, worded by its own `message`. `label` is the fixed line logged when an action throws. */
export function refusals<R extends string>(label: string, message: (reason: R | "stale" | "unknown", fields?: string[]) => string) {
  const unknown: ActionState = { status: "error", message: message("unknown") };
  return {
    unknown,
    failed: (r: { reason: R; fields?: string[] }): ActionState => ({ status: "error", message: message(r.reason, r.fields) }),
    trouble(error: unknown): ActionState {
      console.error(label, error instanceof Error ? error.name : "unknown");
      return unknown;
    },
    stale: () => ({ status: "error" as const, reason: "stale" as const, message: message("stale"), fields: [] as string[] }),
  };
}
