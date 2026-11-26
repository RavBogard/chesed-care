/**
 * A signed "stop these emails" link for one roster member: /join/stop/s/{memberId}.{signature}. It is made from the
 * member's id and the app's secret, so it can be put in any number of emails without making or replacing the member's
 * own stop token (which is stored only as a hash and which nobody sees). Opening it only shows the confirm button.
 */
import { timingSafeEqual } from "node:crypto";
import { isUuid } from "@/server/care/validate";
import { signFor } from "@/server/meals/client-meta";

const PURPOSE = "corps-stop-link";

export function signedStopPath(memberId: string): string {
  return `/join/stop/s/${memberId}.${signFor(PURPOSE, memberId)}`;
}

/** The member id a signed value stands for, or null when it is not one of ours (forged, altered, malformed). */
export function memberOfSignedStop(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 120) return null;
  const [id, signature, ...rest] = value.split(".");
  if (!id || !signature || rest.length > 0 || !isUuid(id)) return null;
  const expected = Buffer.from(signFor(PURPOSE, id));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}
