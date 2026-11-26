"use server";

import { revalidatePath } from "next/cache";
import { type ActionState, fields, runAction, runData, type DataState } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { scheduleReadings } from "@/server/care/ai-reading";
import { createBatch } from "@/server/care/bring-in";
import { splitList, type SplitResult } from "@/server/care/bring-in-split";
import { acceptQuick } from "@/server/care/bring-in";
import { getSalesforce } from "@/server/salesforce";

/** The proposed split of the pasted list. Nothing is stored: the text is read, split and forgotten. */
export async function splitListAction(text: string): Promise<DataState<SplitResult>> {
  return runData(await getViewer(), (actor, db) => splitList(db, actor, text));
}

/** Save the confirmed entries as the clergy member's own, then read them, a few at a time, after the response. */
export async function createBatchAction(entries: string[]): Promise<DataState<{ count: number }>> {
  const result = await runData(await getViewer(), async (actor, db) => {
    const made = await createBatch(db, actor, entries);
    scheduleReadings(db, made.ids);
    return { count: made.ids.length };
  });
  if (result.status === "ok") revalidatePath("/", "layout");
  return result;
}

/** Accept an entry in one tap. The server decides whether that is allowed; otherwise the sheet is needed. */
export async function quickAcceptAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const done = await acceptQuick({ db, sf: getSalesforce, now: new Date() }, actor, f.proposalId, { lastContact: f.lastContact, checkIn: f.checkIn === "on" });
    return `${done.person} is on the care list.`;
  });
}
