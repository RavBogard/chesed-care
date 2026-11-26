"use server";

import { clearAway, setAway } from "@/server/team/away";
import { fields, runAction } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { ownerEmails } from "@/server/env";
import { afterResponse, noticeCoveringTomorrow } from "@/server/notify/notify";
import type { ActionState } from "@/lib/action-state";

/** Set "I'm away" from a date to a date, with an optional colleague covering (the owner may do it for someone else). */
export async function setAwayAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const { nobodyHereFrom } = await setAway(db, actor, f.userId, { from: f.from, until: f.until, coverUserId: f.coverUserId || undefined });
    // A window that starts tomorrow is told to its coverer now: the daily job has already run for tomorrow's notice.
    afterResponse(() => noticeCoveringTomorrow(db, new Date(), ownerEmails()));
    // Someone who is away is told nothing urgent. If that now leaves a day with nobody here, say so plainly.
    return nobodyHereFrom ? `Saved. From ${plainDate(nobodyHereFrom)} everyone on the clergy team is marked away, so an urgent report would not notify anyone. You may want someone to stay reachable.` : "Saved.";
  });
}

/** A date as people say it, for a message ("Friday, December 4"). */
function plainDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export async function clearAwayAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await clearAway(db, actor, f.userId);
    return "You are no longer marked as away.";
  });
}
