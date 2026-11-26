/**
 * A calendar file for one volunteer claim: what kind of help, for whom (the label the poster
 * typed), the date, the time window and the place. PURE. Nothing else goes in.
 */
import { KIND_WORDS } from "@/lib/volunteers-wording";
import { addDays } from "@/server/lifecycle/window";
import { allDayIcs } from "@/server/meals/ics";

export type ClaimEvent = { uid: string; kind: keyof typeof KIND_WORDS; forLabel: string; date: string; timeWindow: string | null; place: string | null; stamp: Date };

export function volunteerIcs(e: ClaimEvent): string {
  return allDayIcs({ product: "Volunteers", uidDomain: "volunteers", uid: e.uid, stamp: e.stamp, date: e.date, nextDay: addDays(e.date, 1), summary: `${KIND_WORDS[e.kind]} for ${e.forLabel}`, location: e.place, description: e.timeWindow ? `Time: ${e.timeWindow}` : null });
}
