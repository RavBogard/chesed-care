"use server";

import type { ActionState } from "@/lib/action-state";
import { ADDED_TO_CARE, MI_ALREADY, MI_TAKEN } from "@/lib/staff-add-wording";
import { fields, runAction } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { staffAddCareItem, staffAddMiSheberach } from "@/server/care/staff-add";
import { noticeAssigned, noticeNewInbox } from "@/server/notify/notify";
import { getSalesforce } from "@/server/salesforce";

/** Staff put a member straight onto a rabbi's care list. The rabbi is told on their phone, without a name. */
export async function staffAddCareAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const made = await staffAddCareItem({ db, sf: getSalesforce }, actor, { contactId: f.contactId, ownerUserId: f.ownerUserId, category: f.category, words: f.words, sensitive: f.sensitive === "on" });
    await noticeAssigned(db, { toUserId: made.ownerUserId, byUserId: actor.id, careItemId: made.careItemId }).catch((error) => console.error("Staff add: notice failed", error instanceof Error ? error.name : "unknown"));
    return ADDED_TO_CARE(made.ownerName);
  });
}

/** Staff put a name straight onto the Mi Sheberach list. */
export async function staffAddMiSheberachAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const made = await staffAddMiSheberach(db, actor, { name: f.name, askedBy: f.askedBy });
    // A name a rabbi must decide about: clergy are told something arrived. It is not sent for a reading, because its text names the sender and says the person once asked not to be listed.
    if (made.proposalId) await noticeNewInbox(db).catch((error) => console.error("Staff add: notice failed", error instanceof Error ? error.name : "unknown"));
    return made.result === "already" ? MI_ALREADY : MI_TAKEN;
  });
}
