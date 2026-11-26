"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { isCareTeam } from "@/server/access/policy";
import { fields, runAction, runData, type DataState } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { listCareItems } from "@/server/care/care-items";
import { createOutsidePerson } from "@/server/care/outside-people";
import { keepToClergy } from "@/server/care/practical";
import { readAgain, scheduleReading } from "@/server/care/ai-reading";
import { acceptProposal, createProposal, dismissProposal, releaseToInbox } from "@/server/care/proposals";
import { reopenProposal } from "@/server/care/closed-reports";
import { getSalesforce } from "@/server/salesforce";

export type Captured = DataState<{ id: string; words: string }> | { status: "idle" };

/** A quick capture: the words, saved as the capturer's own proposal and handed straight back, so the decision sheet opens on them. */
export async function captureAction(_prev: Captured, form: FormData): Promise<Captured> {
  const f = fields(form);
  const result = await runData(await getViewer(), async (actor, db) => {
    const p = await createProposal(db, actor, { rawText: f.words, channel: "capture", reviewScope: "submitter" });
    scheduleReading(db, p.id);
    return { id: p.id, words: p.rawText ?? "" };
  });
  if (result.status === "ok") revalidatePath("/", "layout");
  return result;
}

/** A report from staff, a lead, senior staff or a caregiver. It goes to the clergy Inbox and nowhere else. */
export async function reportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const made = await createProposal(db, actor, { rawText: f.words, channel: "staff" });
    scheduleReading(db, made.id);
    return "Sent. A member of the clergy will see it.";
  });
}

/** The person and what to do with them, from the decision form's fields, as acceptProposal expects it. */
function decisionFrom(form: FormData, f: Record<string, string | undefined>): unknown {
  const followUp = f.followUpTitle?.trim() ? { title: f.followUpTitle, dueDate: f.followUpDue ?? "", ...(f.followUpOwner ? { ownerUserId: f.followUpOwner } : {}) } : undefined;
  const journey = journeyDecision(form, f);
  // "Add to the Mi Sheberach list": the name as it will be read, how long, and who asked.
  const miSheberach = f.miSheberach === "on" ? { name: f.miName ?? "", kind: f.miKind === "standing" ? "standing" : "dated", ...(f.miAskedBy?.trim() ? { askedBy: f.miAskedBy } : {}) } : undefined;
  if (f.careItemId) return { target: { kind: "existing", careItemId: f.careItemId }, summary: f.summary ?? "", ...(followUp ? { followUp } : {}), ...(journey ? { journey } : {}), ...(miSheberach ? { miSheberach } : {}) };
  const restricted = f.restricted === "on";
  const person = f.contactId
    ? { contactId: f.contactId }
    : f.outsidePersonId
      ? { outsidePersonId: f.outsidePersonId }
      : f.newName?.trim()
        ? { newOutsidePerson: { name: f.newName.trim(), ...(f.newPhone?.trim() ? { phone: f.newPhone.trim() } : {}), ...(f.newNote?.trim() ? { note: f.newNote.trim() } : {}) } }
        : undefined;
  return {
    target: { kind: "new" },
    ...(person ? { person } : {}),
    ...(f.category ? { category: f.category } : {}),
    summary: f.summary ?? "",
    location: f.location ?? "",
    learnedFrom: f.learnedFrom ?? "",
    restricted,
    ...(restricted ? { restrictedShowsCarer: f.shows !== "none", accessUserIds: form.getAll("accessUserId").filter((v) => typeof v === "string") } : {}),
    ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
    ...(followUp ? { followUp } : {}),
    ...(f.lastContact ? { lastContact: f.lastContact } : {}),
    ...(journey ? { journey } : {}),
    ...(miSheberach ? { miSheberach } : {}),
  };
}

/** The journey chosen in the accept sheet, if any, with the steps left ticked in its preview. */
function journeyDecision(form: FormData, f: Record<string, string | undefined>): Record<string, unknown> | undefined {
  if (!f.journeyKey) return undefined;
  const weeks = f.journeyInterval ? Number(f.journeyInterval) : undefined;
  return {
    templateKey: f.journeyKey,
    anchorDate: f.journeyAnchor ?? "",
    ...(f.journeySecond ? { secondDate: f.journeySecond } : {}),
    ...(weeks !== undefined ? { intervalWeeks: weeks } : {}),
    ...(f.journeyLead !== undefined ? { leadUserId: f.journeyLead || null } : {}),
    ...(f.journeyPreviewed === "yes" ? { stepIds: form.getAll("journeyStep").filter((v) => typeof v === "string") } : {}),
  };
}

export async function acceptProposalAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const done = await acceptProposal({ db, sf: getSalesforce, now: new Date() }, actor, f.proposalId, decisionFrom(form, f));
    const base = f.careItemId ? `Added to the care of ${done.person}.` : `${done.person} is on the care list.`;
    if (done.miSheberach === "added") return `${base} The name is on the Mi Sheberach list, not yet confirmed.`;
    if (done.miSheberach === "barred") return `${base} The name was not added to the Mi Sheberach list: this person asked not to be listed.`;
    return base;
  });
}

export async function dismissProposalAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await dismissProposal(db, actor, f.proposalId);
    return "Closed without action.";
  });
}

/** "Closed without action": put a dismissed report back in the Inbox, pending, with no reading. */
export async function reopenProposalAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await reopenProposal(db, actor, f.proposalId);
    return "Back in the Inbox.";
  });
}

export async function releaseProposalAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await releaseToInbox(db, actor, f.proposalId);
    return "Sent to the Inbox.";
  });
}

/** Someone not in the directory: a name, a phone and a short note. Returns the new person for the picker to select. */
export async function addOutsidePersonAction(form: FormData): Promise<DataState<{ id: string; name: string }>> {
  const f = fields(form);
  return runData(await getViewer(), async (actor, db) => {
    const p = await createOutsidePerson(db, actor, { name: f.name, phone: f.phone, note: f.note, addressStreet: f.addressStreet, addressCity: f.addressCity, addressState: f.addressState, addressPostalCode: f.addressPostalCode });
    return { id: p.id, name: p.name };
  });
}

export type ExistingItem = { id: string; category: string };

/** The active care items about a person that the actor can read, so the decision sheet can offer "Add to ...". */
export async function existingItemsAction(who: { contactId?: string; outsidePersonId?: string }): Promise<DataState<ExistingItem[]>> {
  return runData(await getViewer(), async (actor, db) => {
    if (!isCareTeam(actor)) return [];
    const filter = who.outsidePersonId ? { outsidePersonId: who.outsidePersonId } : { sfContactId: who.contactId };
    const items = await listCareItems(db, actor, { status: "active", ...filter });
    return items.map((i) => ({ id: i.id, category: i.category }));
  });
}

/** Clergy ask for a proposal with no reading to be read again. */
export async function readAgainAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const outcome = await readAgain(db, actor, f.proposalId);
    if (outcome === "read") return "Read again. Check the suggestion below.";
    if (outcome === "limited") return "That is enough readings for now. Try again in a while.";
    if (outcome === "off") return "The app's AI reading is switched off.";
    return "It could not be read just now. You can fill it in yourself.";
  });
}

/** Pull a practical request back so the Mitzvah Corps lead no longer sees it. */
export async function keepToClergyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await keepToClergy(db, actor, f.proposalId);
    return "Kept to the clergy.";
  });
}
