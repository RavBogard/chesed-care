"use server";

import { canChangeRestriction, type Actor } from "@/server/access/policy";
import { closeCareItem, createCareItem, getCareItem, listCareItemAccess, pauseCareItem, reopenCareItem, resumeCareItem, updateCareItem, type CareItemPatch } from "@/server/care/care-items";
import { contactOccurredAt } from "@/server/care/contact-when";
import { createContactEntry, deleteContactEntry, updateContactEntry } from "@/server/care/contact-log";
import { createFollowUp, deleteFollowUp, setFollowUpDone, updateFollowUp } from "@/server/care/follow-ups";
import { resolvePersonRef } from "@/server/care/person-ref";
import { getSalesforce } from "@/server/salesforce";
import { getViewer } from "@/server/auth/session";
import type { Db } from "@/server/db/types";
import { fields, runAction } from "@/server/auth/action";
import { afterResponse, followUpOwner, noticeAssigned } from "@/server/notify/notify";
import { OUTCOME_KIND, type OutcomeKey } from "@/lib/care-labels";
import type { ActionState } from "@/lib/action-state";

type Prev = ActionState;
type F = Record<string, string | undefined>;

/** Name and household come from Salesforce by Contact Id, never from the form. */
const personFor = (db: Db, actor: Actor, contactId: string | undefined) => resolvePersonRef({ db, sf: getSalesforce, now: new Date() }, actor, contactId);

/** Who a new record is about: an outside person by id, else a Salesforce contact resolved on the server. */
const subjectFor = async (db: Db, actor: Actor, f: F) => (f.outsidePersonId ? { outsidePersonId: f.outsidePersonId } : await personFor(db, actor, f.sfContactId));

const kindOfOutcome = (outcome: string | undefined): string | undefined => (outcome && outcome in OUTCOME_KIND ? OUTCOME_KIND[outcome as OutcomeKey] : undefined);

export async function logContactAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    // Against a care item the item supplies the person (caregivers); otherwise resolve the contact.
    const ref = f.careItemId ? null : await subjectFor(db, actor, f);
    await createContactEntry(db, actor, {
      careItemId: f.careItemId || undefined,
      ...ref,
      kind: kindOfOutcome(f.outcome) ?? f.kind ?? "other",
      outcome: f.outcome || undefined,
      occurredAt: contactOccurredAt(f.when, new Date()),
      note: f.note,
      private: f.private === "on",
    });
    return "Contact logged.";
  });
}

/** The fields of the care record form that Add, Edit and the decision sheet share. */
function careFields(form: FormData, f: F) {
  const restricted = f.restricted === "on";
  return {
    category: f.category,
    summary: f.summary ?? "",
    location: f.location ?? "",
    learnedFrom: f.learnedFrom ?? "",
    ownerUserId: f.ownerUserId || undefined,
    restricted,
    restrictedShowsCarer: f.shows !== "none",
    accessUserIds: restricted ? form.getAll("accessUserId").filter((v): v is string => typeof v === "string") : undefined,
  };
}

export async function addToCareListAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await createCareItem(db, actor, { ...(await subjectFor(db, actor, f)), ...careFields(form, f) });
    return "Added to the care list.";
  });
}

/** Change a care item. The restriction is sent only by its owner, and only what actually changed is patched. */
export async function updateCareItemAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const item = await getCareItem(db, actor, f.careItemId);
    const c = careFields(form, f);
    const patch: CareItemPatch = { category: c.category, summary: c.summary, location: c.location, learnedFrom: c.learnedFrom };
    if (c.ownerUserId && c.ownerUserId !== item.ownerUserId) patch.ownerUserId = c.ownerUserId;
    if (f.restrictionShown === "yes" && canChangeRestriction(actor, item)) {
      const named = await listCareItemAccess(db, actor, item.id);
      const wanted = c.accessUserIds ?? [];
      if (c.restricted !== item.restricted) patch.restricted = c.restricted;
      if (c.restricted && c.restrictedShowsCarer !== item.restrictedShowsCarer) patch.restrictedShowsCarer = c.restrictedShowsCarer;
      if (c.restricted && (wanted.length !== named.length || wanted.some((id) => !named.includes(id)))) patch.accessUserIds = wanted;
    }
    await updateCareItem(db, actor, item.id, patch);
    const passedTo = patch.ownerUserId;
    if (typeof passedTo === "string") afterResponse(() => noticeAssigned(db, { toUserId: passedTo, byUserId: actor.id, careItemId: item.id }));
    return "Saved.";
  });
}

export async function pauseCareItemAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await pauseCareItem(db, actor, f.careItemId, f.pausedUntil);
    return "Paused.";
  });
}

export async function resumeCareItemAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await resumeCareItem(db, actor, f.careItemId);
    return "Back on the list.";
  });
}

export async function reopenCareItemAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await reopenCareItem(db, actor, f.careItemId);
    return "Reopened.";
  });
}

export async function addFollowUpAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const ref = f.careItemId ? null : await subjectFor(db, actor, f);
    await createFollowUp(db, actor, {
      careItemId: f.careItemId || undefined,
      ...ref,
      title: f.title,
      dueDate: f.dueDate,
      ownerUserId: f.ownerUserId || undefined,
    });
    return "Follow-up added.";
  });
}

export async function closeCareItemAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await closeCareItem(db, actor, f.careItemId);
    return "Closed.";
  });
}

/** Mark a follow-up done, or (done = "false") bring it back. With an outcome it also writes the contact entry. */
export async function setFollowUpDoneAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await setFollowUpDone(db, actor, f.followUpId, f.done !== "false", { outcome: f.outcome });
    if (f.done === "false") return "Reopened.";
    return f.outcome ? "Done, and logged." : "Done.";
  });
}

export async function moveFollowUpAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateFollowUp(db, actor, f.followUpId, { dueDate: f.dueDate });
    return "Moved.";
  });
}

/** Edit a follow-up: its title, its day and who has it. */
export async function updateFollowUpAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const before = f.ownerUserId ? await followUpOwner(db, f.followUpId) : null;
    await updateFollowUp(db, actor, f.followUpId, { title: f.title, dueDate: f.dueDate, ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}) });
    const { followUpId, ownerUserId } = f;
    if (followUpId && ownerUserId && ownerUserId !== before) afterResponse(() => noticeAssigned(db, { toUserId: ownerUserId, byUserId: actor.id, followUpId }));
    return "Saved.";
  });
}

export async function deleteFollowUpAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await deleteFollowUp(db, actor, f.followUpId);
    return "Deleted.";
  });
}

/** Change a contact entry (its author only): what happened, the note, whether it is private. */
export async function updateContactAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const kind = kindOfOutcome(f.outcome);
    await updateContactEntry(db, actor, f.entryId, { ...(kind ? { kind } : {}), outcome: f.outcome ?? "", note: f.note ?? "", private: f.private === "on" });
    return "Saved.";
  });
}

export async function deleteContactAction(_prev: Prev, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await deleteContactEntry(db, actor, f.entryId);
    return "Deleted.";
  });
}
