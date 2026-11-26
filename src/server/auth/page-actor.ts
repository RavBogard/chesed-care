import "server-only";
import { redirect } from "next/navigation";
import { isCareTeam, type Actor } from "@/server/access/policy";
import type { ViewerState } from "./session";

/**
 * For a page: the signed-in actor, or a redirect to sign-in / the not-authorised page.
 * Staff, a Mitzvah Corps lead and senior staff only report a need: every page but the ones
 * that say `reporter: true` (Report and Settings) sends them to Report.
 */
export function actorOrRedirect(viewer: ViewerState, opts: { reporter?: boolean } = {}): Actor {
  if (viewer.kind === "signed-out") redirect("/sign-in");
  if (viewer.kind === "not-authorised") redirect("/not-authorised");
  // A Mitzvah Corps lead lands on their home, Volunteers; staff and senior staff on Report (which a lead can still open).
  if (!opts.reporter && !isCareTeam(viewer.actor)) redirect(viewer.actor.role === "lead" ? "/volunteers" : "/report");
  return viewer.actor;
}
