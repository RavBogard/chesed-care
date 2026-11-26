"use server";

import { markVisited, setVisitLocation } from "@/server/care/visits";
import { fields, runAction } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import type { ActionState } from "@/lib/action-state";

/** One tap: log a visit with this person (the ordinary contact entry). */
export async function visitedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await markVisited(db, actor, f.careItemId);
    return "Visit logged.";
  });
}

/** Say where a person is, for one with no place on the list. */
export async function setVisitLocationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await setVisitLocation(db, actor, f.careItemId, f.location);
    return "Saved.";
  });
}
