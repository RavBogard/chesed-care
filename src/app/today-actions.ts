"use server";

import { dismissSuggestion } from "@/server/care/suggestions";
import { setTodayPrefs, type TodayPrefs } from "@/server/care/today-prefs";
import { fields, runAction, runData, type DataState } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import type { ActionState } from "@/lib/action-state";

/** Remember the signed-in person's Today choices (one kind, hide birthdays). */
export async function saveTodayPrefsAction(kind: string | null, hideBirthdays: boolean): Promise<DataState<TodayPrefs>> {
  return runData(await getViewer(), (actor, db) => setTodayPrefs(db, actor, { kind, hideBirthdays }));
}

/** Set a "You might reach out to" suggestion aside for 30 days. */
export async function dismissSuggestionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await dismissSuggestion(db, actor, { kind: f.kind, subjectId: f.subjectId });
    return "Set aside for 30 days.";
  });
}
