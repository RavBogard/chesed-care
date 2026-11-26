"use server";

import type { ActionState } from "@/lib/action-state";
import { fields, runAction } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { markOccasion, unmarkOccasion } from "@/server/care/occasion-marks";

function markInput(form: FormData) {
  const f = fields(form);
  return {
    occasionType: f.occasionType,
    subjectId: f.subjectId,
    sfAccountId: f.sfAccountId || undefined,
    sfContactId: f.sfContactId || undefined,
    year: Number(f.year),
  };
}

/** "Done": mark an occasion as handled for this year (shared by the team). */
export async function markOccasionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(await getViewer(), async (actor, db) => {
    await markOccasion(db, actor, markInput(form));
    return "Marked done.";
  });
}

export async function unmarkOccasionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(await getViewer(), async (actor, db) => {
    await unmarkOccasion(db, actor, markInput(form));
    return "Marked not done.";
  });
}
