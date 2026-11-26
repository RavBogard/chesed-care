"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { fields, runAction, runData } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { takePracticalRequest } from "@/server/care/practical";
import { cancelVolunteerSeries, createVolunteerSeries, updateVolunteerSeries } from "@/server/volunteers/series";
import { removeFromAllDates, cancelVolunteerSheet, closeLinksForCareItem, getBoardLink, replaceBoardLink, cancelVolunteerTask, createVolunteerSheet, createVolunteerTask, markVolunteerTaskDone, removeBringing, removeClaim, updateVolunteerTask } from "@/server/volunteers/organiser";

const blankToNull = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v);

/** A people count typed in a box: nothing means "the default for this kind". */
function count(v: string | undefined): { peopleNeeded?: number } {
  if (v === undefined || v.trim() === "") return {};
  const n = Number(v);
  return { peopleNeeded: Number.isInteger(n) ? n : Number.NaN };
}

/** Post a task. Then to its page, where its link and share buttons are. */
export async function createTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  const result = await runData(await getViewer(), async (actor, db) => {
    const task = {
      kind: f.kind ?? "",
      forLabel: f.forLabel ?? "",
      needed: f.needed ?? "",
      date: f.date ?? "",
      timeWindow: blankToNull(f.timeWindow),
      place: blankToNull(f.place),
      contactLine: blankToNull(f.contactLine),
      ...count(f.peopleNeeded),
      ...(f.careItemId ? { careItemId: f.careItemId } : {}),
    };
    // A repeating task: the same words on each chosen weekday, every week or every second week, for a number of times or until a date.
    if (f.repeat === "weekly" || f.repeat === "biweekly") {
      const weekdays = form.getAll("weekdays").map((v) => Number(v));
      const end = f.end === "until" ? { until: f.until ?? "" } : { count: Number(f.times) };
      const made = await createVolunteerSeries(db, actor, { ...task, every: f.repeat === "weekly" ? 1 : 2, weekdays, ...end });
      return { id: made.first.id };
    }
    return { id: (await createVolunteerTask(db, actor, task)).id };
  });
  if (result.status === "error") return result;
  revalidatePath("/volunteers");
  redirect(`/volunteers/${result.data.id}`);
}

/** Change an open task's words, date, place, count or contact line. */
export async function updateTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateVolunteerTask(db, actor, f.taskId, {
      kind: f.kind ?? "",
      forLabel: f.forLabel ?? "",
      needed: f.needed ?? "",
      date: f.date ?? "",
      timeWindow: blankToNull(f.timeWindow),
      place: blankToNull(f.place),
      contactLine: blankToNull(f.contactLine),
      ...count(f.peopleNeeded),
    });
    return "Saved.";
  });
}

/** Change the words or time of this task's series from today on: unclaimed dates always, claimed ones only when ticked. */
export async function updateSeriesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const patch: Record<string, string | null> = {};
    for (const k of ["forLabel", "needed", "timeWindow", "place", "contactLine"] as const) if (f[k] !== undefined) patch[k] = k === "forLabel" || k === "needed" ? f[k]! : blankToNull(f[k]);
    const out = await updateVolunteerSeries(db, actor, f.taskId, patch, f.includeClaimed === "on");
    const left = out.claimedLeft === 1 ? "1 date that someone has taken was left as it was." : out.claimedLeft > 1 ? `${out.claimedLeft} dates that someone has taken were left as they were.` : "";
    return `${out.changed === 1 ? "Changed 1 date." : `Changed ${out.changed} dates.`} ${left}`.trim();
  });
}

/** Cancel the unclaimed dates still ahead; the claimed ones too only when ticked. */
export async function cancelSeriesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const out = await cancelVolunteerSeries(db, actor, f.taskId, f.includeClaimed === "on");
    const left = out.claimedLeft === 1 ? " 1 date that someone has taken is still on." : out.claimedLeft > 1 ? ` ${out.claimedLeft} dates that someone has taken are still on.` : "";
    return `${out.changed === 1 ? "Cancelled 1 date." : `Cancelled ${out.changed} dates.`}${left}`;
  });
}

export async function cancelTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await cancelVolunteerTask(db, actor, f.taskId);
    return "Cancelled. The link no longer works.";
  });
}

export async function doneTaskAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await markVolunteerTaskDone(db, actor, f.taskId);
    return "Marked done.";
  });
}

/** Take a volunteer's place away, and with the tick box stop that contact from taking this task again. */
export async function removeClaimAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await removeClaim(db, actor, f.claimId, f.block === "on");
    return "Removed. The place is open again.";
  });
}

/** Take an "every time" volunteer off every date of the series, and with the tick box stop that contact from taking any date of it again. */
export async function removeFromAllDatesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await removeFromAllDates(db, actor, f.claimId, f.block === "on");
    return "Removed from every date. The places are open again.";
  });
}

/** Post a shiva sheet: the evenings come as paired `date` and `window` fields. */
export async function createSheetAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  const dates = form.getAll("date").filter((v): v is string => typeof v === "string");
  const windows = form.getAll("window").filter((v): v is string => typeof v === "string");
  const result = await runData(await getViewer(), async (actor, db) => {
    const sheet = await createVolunteerSheet(db, actor, {
      title: f.title ?? "",
      needed: blankToNull(f.needed),
      place: blankToNull(f.place),
      contactLine: blankToNull(f.contactLine),
      evenings: dates.flatMap((date, i) => (date.trim() === "" ? [] : [{ date, timeWindow: blankToNull(windows[i]) }])),
      ...(f.careItemId ? { careItemId: f.careItemId } : {}),
    });
    return { id: sheet.id };
  });
  if (result.status === "error") return result;
  revalidatePath("/volunteers");
  redirect(`/volunteers/sheets/${result.data.id}`);
}

export async function cancelSheetAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await cancelVolunteerSheet(db, actor, f.groupId);
    return "Cancelled. The link no longer works.";
  });
}

export async function removeBringingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await removeBringing(db, actor, f.groupId, f.bringingId);
    return "Removed.";
  });
}

/** Make the poster's board link (the same one every time after the first). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the shape every form action has
export async function makeBoardLinkAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  return runAction(await getViewer(), async (actor, db) => {
    await getBoardLink(db, actor);
    return "Your board link is ready.";
  });
}

/** Replace the board link: the old one stops working at once. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the shape every form action has
export async function replaceBoardLinkAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  return runAction(await getViewer(), async (actor, db) => {
    await replaceBoardLink(db, actor);
    return "Done. The old board link no longer works.";
  });
}

/** Close the public links of the open tasks linked to a care item that has become restricted. */
export async function closeLinksAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const n = await closeLinksForCareItem(db, actor, f.careItemId);
    return n === 1 ? "Closed 1 link." : `Closed ${n} links.`;
  });
}

/** "I'll take this" on a practical request. The first to press wins; the other is told it is taken. */
export async function takePracticalRequestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  const result = await runData(await getViewer(), (actor, db) => takePracticalRequest(db, actor, f.proposalId));
  if (result.status === "error") return result;
  revalidatePath("/volunteers");
  return result.data.ok ? { status: "ok", message: "It is yours." } : { status: "error", message: "Someone has already taken this." };
}
