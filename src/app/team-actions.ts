"use server";

import { getCareItem, updateCareItem } from "@/server/care/care-items";
import { reassignFollowUp } from "@/server/team/reassign";
import { fields, runAction } from "@/server/auth/action";
import { afterResponse, followUpOwner, noticeAssigned } from "@/server/notify/notify";
import { getViewer } from "@/server/auth/session";
import type { ActionState } from "@/lib/action-state";

/** Give a care item to someone else from the team view: the ordinary reassign (updateCareItem), so the same policy and the same audit row. */
export async function reassignCareItemAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const before = await getCareItem(db, actor, f.careItemId);
    await updateCareItem(db, actor, f.careItemId, { ownerUserId: f.ownerUserId });
    const { careItemId, ownerUserId } = f;
    // Only when the holder really changed, and the new holder is not the person who gave it.
    if (careItemId && ownerUserId && ownerUserId !== before.ownerUserId && ownerUserId !== actor.id) afterResponse(() => noticeAssigned(db, { toUserId: ownerUserId, byUserId: actor.id, careItemId }));
    return "Given.";
  });
}

/** Give a follow-up to someone else from the team view, through the ordinary reassign path. */
export async function reassignFollowUpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const before = await followUpOwner(db, f.followUpId);
    await reassignFollowUp(db, actor, f.followUpId, f.ownerUserId);
    const { followUpId, ownerUserId } = f;
    if (followUpId && ownerUserId && ownerUserId !== before && ownerUserId !== actor.id) afterResponse(() => noticeAssigned(db, { toUserId: ownerUserId, byUserId: actor.id, followUpId }));
    return "Given.";
  });
}
