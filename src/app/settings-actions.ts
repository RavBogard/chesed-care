"use server";

import { revalidatePath } from "next/cache";
import { createCaptureToken, revokeCaptureToken } from "@/server/care/capture-tokens";
import { disconnectOwnConnections } from "@/server/auth/connections";
import { handOverRestrictedItems } from "@/server/care/care-items";
import { addUser, updateUser } from "@/server/care/users";
import { setTextDraft } from "@/server/care/text-drafts";
import { handOverWork } from "@/server/team/handover";
import { getViewer } from "@/server/auth/session";
import { fields, runAction, runData } from "@/server/auth/action";
import type { ActionState } from "@/lib/action-state";
import { ownerEmails } from "@/server/env";
import { afterResponse, noticeAssignedMany, type AssignedMany } from "@/server/notify/notify";

/** Save my draft for one occasion type; the "reset" button (or a blank draft) returns it to the standard message. */
export async function saveTextDraftAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const reset = f.intent === "reset";
    await setTextDraft(db, actor, { occasionType: f.occasionType, body: reset ? "" : f.body });
    return reset ? "Back to the standard message." : "Saved.";
  });
}

/** Disconnect Claude for the signed-in person: ends all of their own connector tokens and grants. */
export async function disconnectConnectorAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  void _form;
  return runAction(await getViewer(), async (actor, db) => {
    await disconnectOwnConnections(db, actor);
    return "Disconnected.";
  });
}

export async function addTeamMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await addUser(db, actor, { email: f.email, name: f.name || undefined, role: f.role });
    return "Added. They can sign in with that Google account.";
  });
}

export async function setTeamMemberActiveAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateUser(db, actor, f.userId, { active: f.active === "true" }, ownerEmails());
    return f.active === "true" ? "Reactivated." : "Deactivated.";
  });
}

/**
 * The hand-over sheet: give what the person holds (open items and follow-ups that are not
 * restricted) to the chosen people, then deactivate them. Restricted items are not touched here.
 */
export async function handOverWorkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const itemOverrides: Record<string, string> = {};
    const followUpOverrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(f)) {
      if (!value) continue;
      if (key.startsWith("item:")) itemOverrides[key.slice(5)] = value;
      if (key.startsWith("fu:")) followUpOverrides[key.slice(3)] = value;
    }
    // One transaction: work is never moved from someone who then is not deactivated.
    const passed = new Map<string, AssignedMany>();
    const moved = await db.transaction(async (tx) => {
      passed.clear();
      const result = await handOverWork(tx, actor, f.userId, { itemsTo: f.itemsTo, followUpsTo: f.followUpsTo, leadStepsTo: f.leadStepsTo, itemOverrides, followUpOverrides }, ownerEmails(), (toUserId, what) => {
        const entry = passed.get(toUserId) ?? { toUserId, byUserId: actor.id, careItemIds: [], followUpIds: [] };
        if (what.careItemId) entry.careItemIds.push(what.careItemId);
        if (what.followUpId) entry.followUpIds.push(what.followUpId);
        passed.set(toUserId, entry);
      });
      await updateUser(tx, actor, f.userId, { active: false }, ownerEmails());
      return result;
    });
    // One notice per person who was given work (after the response, and only about what they can open).
    for (const entry of passed.values()) afterResponse(() => noticeAssignedMany(db, entry));
    const n = moved.items + moved.followUps;
    return n === 1 ? "Handed over 1 thing. Deactivated." : `Handed over ${n} things. Deactivated.`;
  });
}

export async function changeTeamMemberRoleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateUser(db, actor, f.userId, { role: f.role }, ownerEmails());
    return "Role changed.";
  });
}

/** The blind hand-over of a departed holder's restricted items to one active clergy member. Only a count comes back. */
export async function handOverRestrictedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const { count } = await handOverRestrictedItems(db, actor, f.fromUserId, f.toUserId);
    return count === 1 ? "Handed over 1 restricted item." : `Handed over ${count} restricted items.`;
  });
}

export type NewTokenState = { status: "idle" } | { status: "ok"; token: string } | { status: "error"; message: string };

/** Make a capture token for the signed-in person. The token comes back once, to the screen that asked; it is not kept. */
export async function createCaptureTokenAction(): Promise<NewTokenState> {
  const made = await runData(await getViewer(), async (actor, db) => (await createCaptureToken(db, actor)).token);
  if (made.status === "error") return { status: "error", message: made.message };
  revalidatePath("/settings");
  return { status: "ok", token: made.data };
}

/** End one of the signed-in person's own capture tokens. */
export async function revokeCaptureTokenAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await revokeCaptureToken(db, actor, f.tokenId);
    return "Ended.";
  });
}
