"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { fields, runAction, runData, type DataState } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { InvalidInput } from "@/server/care/validate";
import { appOrigin } from "@/server/env";
import { acceptAllPending, acceptMember, addFromPastHelper, addMember, dismissJoinAgain, makeStopLink, markMemberLeft, pauseMember, emailAsk, prepareAsk, reactivateMember, updateMember, type AskPrepared, type EmailAsked } from "@/server/volunteers/roster";
import { CAN_DO, HOW_OFTEN, PREFER_CONTACT } from "@/lib/can-do";

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v);
/** Empty clears; an unknown value is refused, so a tampered form cannot silently clear a saved choice. */
const pick = (v: string | undefined, allowed: readonly string[]) => {
  if (v === undefined || v === "") return null;
  if (!allowed.includes(v)) throw new InvalidInput("choice");
  return v;
};
const canDoOf = (form: FormData) => form.getAll("canDo").filter((v): v is string => typeof v === "string" && (CAN_DO as readonly string[]).includes(v));

const memberFields = (f: Record<string, string | undefined>, form: FormData) => ({
  firstName: f.firstName ?? "",
  lastName: f.lastName ?? "",
  email: blank(f.email),
  mobile: blank(f.mobile),
  canDo: canDoOf(form),
  availability: blank(f.availability),
  area: blank(f.area),
  howOften: pick(f.howOften, HOW_OFTEN),
  preferContact: pick(f.preferContact, PREFER_CONTACT),
  coordinatorNotes: blank(f.coordinatorNotes),
});

export async function addMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await addMember(db, actor, memberFields(f, form));
    revalidatePath("/volunteers/roster");
    return "Added to the roster.";
  });
}

export async function updateMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateMember(db, actor, f.memberId, memberFields(f, form));
    revalidatePath("/volunteers/roster");
    return "Saved.";
  });
}

export async function pauseMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await pauseMember(db, actor, f.memberId, f.until);
    return "Paused. They will not be asked until that day.";
  });
}

export async function markLeftAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await markMemberLeft(db, actor, f.memberId);
    return "Marked as left. Their contact details will be deleted in 30 days.";
  });
}

export async function reactivateMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await reactivateMember(db, actor, f.memberId, { confirmed: f.confirm === "yes" });
    return "Active again.";
  });
}

/** Accept someone the sign-up page made (one tap). A person who had stopped needs the confirmation too. */
export async function acceptMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await acceptMember(db, actor, f.memberId, { confirmed: f.confirm === "yes" });
    return "Accepted. They can now be asked.";
  });
}

/** Accept everyone waiting, except anyone who had stopped before (they are confirmed one at a time). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the shape every form action has
export async function acceptAllPendingAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  return runAction(await getViewer(), async (actor, db) => {
    const n = await acceptAllPending(db, actor);
    return n === 1 ? "Accepted 1 person." : `Accepted ${n} people.`;
  });
}

/** Clear the "asked to join again" note without bringing anyone back. */
export async function dismissJoinAgainAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await dismissJoinAgain(db, actor, f.memberId);
    return "Cleared.";
  });
}

export async function addPastHelperAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await addFromPastHelper(db, actor, f.key);
    return "Added to the roster.";
  });
}

/** A stop link, shown once: only its hash is kept. */
export async function makeStopLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    // A link already made is replaced only when the coordinator chose that (the screen says so).
    const { token } = await makeStopLink(db, actor, f.memberId, f.replace === "yes");
    return `Give them this link. It is shown only now, and the old link no longer works: ${appOrigin()}/join/stop/${token}`;
  });
}

/** Record who was asked and hand back what the coordinator needs to ask them from their own phone or mail app. Nothing is sent. */
export async function askRosterAction(input: { taskId?: string; groupId?: string; memberIds: string[] }): Promise<DataState<AskPrepared>> {
  const target = input.groupId ? { groupId: input.groupId } : { taskId: input.taskId ?? "" };
  return runData(await getViewer(), async (actor, db) => {
    let origin = "";
    try {
      origin = appOrigin();
    } catch {
      // Without the app's address there is no whole link to send; prepareAsk refuses.
    }
    return prepareAsk(db, actor, target, input.memberIds, origin);
  });
}

/** "Send from CRC Care": the same ask, emailed from the app to each chosen member who has an address (at most 60 a press). */
export async function emailRosterAction(input: { taskId?: string; groupId?: string; memberIds: string[] }): Promise<DataState<EmailAsked>> {
  const target = input.groupId ? { groupId: input.groupId } : { taskId: input.taskId ?? "" };
  return runData(await getViewer(), async (actor, db) => {
    let origin = "";
    try {
      origin = appOrigin();
    } catch {
      // Without the app's address there is no whole link to send; the ask refuses.
    }
    return emailAsk(db, actor, target, input.memberIds, origin);
  });
}
