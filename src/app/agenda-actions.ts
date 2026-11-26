"use server";

import { addAgendaEntry, carryAgendaEntry, discussAgendaEntry, removeAgendaEntry } from "@/server/care/agenda";
import { fields, runAction } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { afterResponse, noticeAssigned } from "@/server/notify/notify";
import type { ActionState } from "@/lib/action-state";

/** Put a care item, a person or a line of free text on this week's agenda. */
export async function addAgendaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const out = await addAgendaEntry(db, actor, { careItemId: f.careItemId || undefined, sfContactId: f.sfContactId || undefined, outsidePersonId: f.outsidePersonId || undefined, displayName: f.displayName || undefined, why: f.why });
    return out.restricted ? "Added. Only the clergy named on this restricted item will see it." : "Added to this week's agenda.";
  });
}

/** Tick an entry as discussed, with an optional outcome and an optional follow-up for a chosen clergy member. */
export async function discussAgendaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const followUp = f.followUpOwner ? { ownerUserId: f.followUpOwner, title: f.followUpTitle || undefined } : null;
    const out = await discussAgendaEntry(db, actor, f.entryId, { outcome: f.outcome, followUp });
    const to = f.followUpOwner;
    if (out.followUpId && to && to !== actor.id) afterResponse(() => noticeAssigned(db, { toUserId: to, byUserId: actor.id, followUpId: out.followUpId! }));
    return out.followUpId ? "Marked as discussed. The follow-up is made." : "Marked as discussed.";
  });
}

export async function carryAgendaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await carryAgendaEntry(db, actor, f.entryId);
    return "Carried to next week.";
  });
}

export async function removeAgendaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await removeAgendaEntry(db, actor, f.entryId);
    return "Removed.";
  });
}
