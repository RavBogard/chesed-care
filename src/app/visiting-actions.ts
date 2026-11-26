"use server";

import type { ActionState } from "@/lib/action-state";
import { fields, runAction } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { getSalesforce } from "@/server/salesforce";
import { addToVisitingList, endVisitingEntry, logVisit, setVisitor, updateVisitingEntry } from "@/server/volunteers/visiting";

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v);

/** Clergy put a person on the volunteer visiting list (from their page). */
export async function addToVisitingListAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await addToVisitingList(db, actor, { sfContactId: blank(f.sfContactId), outsidePersonId: blank(f.outsidePersonId), place: blank(f.place), contactLine: blank(f.contactLine), visitorNote: blank(f.visitorNote) }, { sf: getSalesforce });
    return "Added to the visiting list.";
  });
}

export async function updateVisitingEntryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateVisitingEntry(db, actor, f.entryId, { place: blank(f.place), contactLine: blank(f.contactLine), visitorNote: blank(f.visitorNote) });
    return "Saved.";
  });
}

export async function endVisitingEntryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await endVisitingEntry(db, actor, f.entryId);
    return "Taken off the visiting list.";
  });
}

/** The regular visitor: a roster member, or nobody (an empty choice). */
export async function setVisitorAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await setVisitor(db, actor, f.entryId, blank(f.memberId));
    return "Saved.";
  });
}

export async function logVisitAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await logVisit(db, actor, f.entryId, f.visitedOn);
    return "Visit logged.";
  });
}
