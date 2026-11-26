"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { SYNC_BUSY, SYNC_DONE, SYNC_LIMITED, SYNC_NOTHING, syncProblem } from "@/lib/misheberach-wording";
import { fields, runAction, runData } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { addEntry, endEntry, MiSheberachBarred, renewEntry, updateEntry } from "@/server/misheberach/list";
import { packetFromEnv, syncMode } from "@/server/misheberach/google";
import { describePacket, syncNow, type SyncOptions } from "@/server/misheberach/sync";

type F = Record<string, string | undefined>;

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v);

const person = (f: F) => ({ sfContactId: blank(f.contactId), outsidePersonId: blank(f.outsidePersonId) });

/** Add a name at once (marked not yet confirmed), then back to the list. A person who asked not to be listed needs the "I have checked" box. */
export async function addEntryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  const result = await runData(await getViewer(), async (actor, db) => {
    try {
      const { created } = await addEntry(db, actor, { name: f.name, kind: f.kind, askedBy: f.askedBy, ...person(f), careItemId: blank(f.careItemId), specialRequest: f.specialRequest === "on", override: f.override === "on" });
      return { created };
    } catch (error) {
      if (error instanceof MiSheberachBarred) return { barred: true as const };
      throw error;
    }
  });
  if (result.status === "error") return result;
  if ("barred" in result.data) return { status: "error", message: "This person asked not to be listed. Tick “I have checked with them” to add them anyway." };
  revalidatePath("/", "layout");
  redirect("/mi-sheberach");
}

/** Change a name, who asked, how long it stays, or whether the person has agreed. */
export async function updateEntryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateEntry(db, actor, f.entryId, { name: f.name, kind: f.kind, askedBy: f.askedBy, consent: f.consent, specialRequest: f.specialRequest === "on" });
    return "Saved.";
  });
}

/** Take a name off, with the reason. */
export async function endEntryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await endEntry(db, actor, f.entryId, f.reason);
    return "Taken off the list.";
  });
}

/** The one-tap answers to "still needed?". */
export async function renewEntryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await renewEntry(db, actor, f.entryId, f.choice);
    return f.choice === "let_off" ? "Taken off the list." : "Kept.";
  });
}

/** The result of a sync button as the screen reads it. A run that stopped says why in a fixed sentence (never the packet's words). */
async function syncAs(viewer: Awaited<ReturnType<typeof getViewer>>, opts: Omit<SyncOptions, "mode">, done: string): Promise<ActionState> {
  const mode = syncMode();
  const result = await runData(viewer, (actor, db) => syncNow(db, packetFromEnv(), actor, new Date(), { ...opts, mode }));
  if (result.status === "error") return result;
  revalidatePath("/", "layout");
  const r = result.data;
  if (r.status === "limited") return { status: "error", message: SYNC_LIMITED };
  if (r.status === "busy") return { status: "error", message: SYNC_BUSY };
  if (r.status === "not_connected") return { status: "error", message: SYNC_NOTHING };
  if (r.status === "failed") return { status: "error", message: syncProblem(r.errorName) };
  return { status: "ok", message: r.dryRun && !opts.importOnly ? "Checked. See what it would do below." : done };
}

/** "Sync now": clergy and owner, rate limited. */
export async function syncNowAction(): Promise<ActionState> {
  return syncAs(await getViewer(), {}, SYNC_DONE);
}

/** "Import the current list": the trial mode's one first-run write, entries only. */
export async function importCurrentAction(): Promise<ActionState> {
  return syncAs(await getViewer(), { importOnly: true }, "Imported. The packet was not changed.");
}

/** "Apply anyway": the one run a clergy member has looked at and confirmed, although the sanity brake stopped it. Audited. */
export async function applyAnywayAction(): Promise<ActionState> {
  return syncAs(await getViewer(), { force: true }, SYNC_DONE);
}

/** "Remove it from the packet": takes the lines of people who asked not to be listed out of the packet, through the normal write. Audited. */
export async function removeBarredAction(): Promise<ActionState> {
  return syncAs(await getViewer(), { removeBarred: true }, "Removed from the packet.");
}

/** The owner's diagnostic: the shape of the Healing Prayers list as counts, never a name. */
export async function describePacketAction(): Promise<ActionState> {
  const result = await runData(await getViewer(), (actor, db) => describePacket(db, packetFromEnv(), actor));
  if (result.status === "error") return result;
  if (result.data === "limited") return { status: "error", message: SYNC_LIMITED };
  if (result.data === null) return { status: "error", message: SYNC_NOTHING };
  const d = result.data;
  const hist = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  return { status: "ok", message: `Bullets ${d.bullets}; other paragraphs ${d.otherParagraphs}; bold ${hist(d.boldShapes)}; nesting ${hist(d.nesting)}; suggested edits ${d.suggestions ? "yes" : "no"}; rule line is a bullet ${d.ruleLineIsBullet ?? "not found"}; AV line is a bullet ${d.avLineIsBullet ?? "not found"}.` };
}
