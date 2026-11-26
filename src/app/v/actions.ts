"use server";

/**
 * The public volunteer actions: no account, so there is no viewer to resolve. Each is keyed
 * by a secret link the caller holds, and each builds its own clientMeta on the server from the
 * platform's address and a server-signed render time (never from anything the browser sends
 * about itself). They log nothing: no names, contacts, places, tokens or free text.
 */
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { FLAG_WORDS, refusalMessage, type PublicReason } from "@/lib/volunteers-wording";
import { isUuid } from "@/server/care/validate";
import { refCookie } from "@/lib/vol-cookie";
import { volunteerSignupMail } from "@/lib/email-wording";
import { getDb } from "@/server/db/client";
import { afterEmail, sendEmail } from "@/server/email/send";
import { appOrigin } from "@/server/env";
import { tokenHash } from "@/server/meals/tokens";
import { normalizeContact } from "@/server/volunteers/input";
import { elapsedSinceStamp } from "@/server/meals/client-meta";
import { clientMeta, refusals, text } from "@/server/public/form";
import { flagForRabbis } from "@/server/volunteers/flag";
import { addBringing, cancelMyClaim, cancelMySeries, claimEveryTime, claimOnSheet, claimTask, getMySeries, markMyClaimDone, type Refused } from "@/server/volunteers/public";

export type ClaimState = { status: "idle" } | { status: "error"; message: string; reason: PublicReason; fields: string[] };

/**
 * The volunteer's own first-party cookie: one opaque random id (HttpOnly, SameSite=Lax, 180 days; `__Host-` in production, see src/lib/vol-cookie.ts), set when they
 * claim. It is kept on their claims so their personal pages can list what they have taken on this device. It is
 * not shared with anything, not derived from a contact, and nothing is ever looked up by email or mobile.
 */
async function personRef(): Promise<string | null> {
  try {
    const existing = (await cookies()).get(refCookie(process.env.NODE_ENV).name)?.value;
    return isUuid(existing) ? existing : randomUUID();
  } catch {
    return null;
  }
}
async function rememberRef(ref: string | null): Promise<void> {
  if (!ref) return;
  try {
    const { name, options } = refCookie(process.env.NODE_ENV);
    (await cookies()).set(name, ref, options);
  } catch {
    // A page that cannot set a cookie still works: the personal page just lists no other dates.
  }
}

const { failed, trouble, stale } = refusals<Refused["reason"]>("Volunteers action failed", refusalMessage);

const claimFields = (form: FormData) => ({
  firstName: text(form, "firstName"),
  lastName: text(form, "lastName"),
  contact: text(form, "contact"),
  note: text(form, "note"),
  mayAskAgain: text(form, "mayAskAgain") === "on",
});

/**
 * The thank-you email, only when the contact is an email address: the date and the link to the volunteer's own page,
 * and nothing about the place or the person helped. Sent after the response so the redirect is not delayed.
 */
function confirmByEmail(contact: string, ref: string, manageToken: string, first: () => Promise<string | null>, repeating: boolean): void {
  const n = contact.includes("@") ? normalizeContact(contact) : null;
  if (!n) return;
  afterEmail(async () => {
    const date = await first();
    if (!date) return;
    const mail = volunteerSignupMail({ date, pageUrl: `${appOrigin()}/v/c/${manageToken}`, repeating });
    await sendEmail(getDb(), { to: n.contact, ...mail, kind: "volunteer_signup", ref });
  });
}

/** Claim a task, or one evening of a shiva sheet (`taskId` set). On success: straight to the volunteer's own page, which holds the place, the calendar file and the link to cancel. */
export async function claimAction(_prev: ClaimState, form: FormData): Promise<ClaimState> {
  const token = text(form, "token");
  const taskId = text(form, "taskId");
  let manageToken: string;
  try {
    // A missing, forged or day-old stamp is a form that was not rendered by us a short while ago.
    if (elapsedSinceStamp(text(form, "stamp"), token, new Date()) === null) return stale();
    const meta = await clientMeta(token, form, true);
    if (!meta) return { status: "error", reason: "refused", message: refusalMessage("refused"), fields: [] };
    const ref = await personRef();
    const opts = { personRef: ref };
    const result = taskId ? await claimOnSheet(getDb(), token, taskId, claimFields(form), meta, new Date(), opts) : await claimTask(getDb(), token, claimFields(form), meta, new Date(), opts);
    if (!result.ok) return { status: "error", reason: result.reason, message: refusalMessage(result.reason, result.fields), fields: result.fields ?? [] };
    manageToken = result.manageToken;
    const { claimId, details } = result;
    confirmByEmail(text(form, "contact"), claimId, manageToken, async () => details.date, false);
    await rememberRef(ref);
  } catch (error) {
    console.error("Volunteers claim failed", error instanceof Error ? error.name : "unknown");
    return { status: "error", reason: "unknown", message: refusalMessage("unknown"), fields: [] };
  }
  redirect(`/v/c/${manageToken}?new=1`);
}

/** Add a "bringing" line to a shiva sheet. */
export async function bringingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    if (elapsedSinceStamp(text(form, "stamp"), token, new Date()) === null) return { status: "error", message: refusalMessage("stale") };
    const meta = await clientMeta(token, form, true);
    if (!meta) return failed({ reason: "refused" });
    const result = await addBringing(getDb(), token, { firstName: text(form, "firstName"), line: text(form, "line") }, meta);
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/v", "layout");
  return { status: "ok", message: "Added. Thank you." };
}

/** Give the place back. */
export async function cancelClaimAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const result = await cancelMyClaim(getDb(), token, meta);
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/v", "layout");
  return { status: "ok", message: "Your place has been given back. Thank you for letting us know." };
}

/** Say it was done, with an optional line back to whoever posted it. */
export async function doneClaimAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const result = await markMyClaimDone(getDb(), token, text(form, "note"), meta);
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/v", "layout");
  return { status: "ok", message: "Marked done. Thank you." };
}

export type FlagState = { status: "idle" } | { status: "sent" } | { status: "error"; message: string };

/** "Something a rabbi should know": the words go to the clergy Inbox and nowhere else. The volunteer is told only that it was sent. */
export async function flagAction(_prev: FlagState, form: FormData): Promise<FlagState> {
  const token = text(form, "token");
  try {
    if (elapsedSinceStamp(text(form, "stamp"), token, new Date()) === null) return { status: "error", message: refusalMessage("stale") };
    const meta = await clientMeta(token, form, true);
    if (!meta) return { status: "error", message: refusalMessage("refused") };
    const result = await flagForRabbis(getDb(), token, text(form, "words"), meta);
    if (!result.ok) return { status: "error", message: result.reason === "rate_limited" ? FLAG_WORDS.flagLater : refusalMessage(result.reason, result.fields) };
  } catch (error) {
    console.error("Volunteers flag failed", error instanceof Error ? error.name : "unknown");
    return { status: "error", message: refusalMessage("unknown") };
  }
  return { status: "sent" };
}

/** "I can do this every time": every open date of the task's series in one go, then straight to the volunteer's own page listing them all. */
export async function claimEveryTimeAction(_prev: ClaimState, form: FormData): Promise<ClaimState> {
  const token = text(form, "token");
  let manageToken: string;
  try {
    if (elapsedSinceStamp(text(form, "stamp"), token, new Date()) === null) return stale();
    const meta = await clientMeta(token, form, true);
    if (!meta) return { status: "error", reason: "refused", message: refusalMessage("refused"), fields: [] };
    const ref = await personRef();
    const result = await claimEveryTime(getDb(), token, claimFields(form), meta, new Date(), { personRef: ref });
    if (!result.ok) return { status: "error", reason: result.reason, message: refusalMessage(result.reason, result.fields), fields: result.fields ?? [] };
    manageToken = result.manageToken;
    const mine = result.manageToken;
    confirmByEmail(text(form, "contact"), tokenHash(mine), mine, async () => (await getMySeries(getDb(), mine))?.dates[0]?.date ?? null, true);
    await rememberRef(ref);
  } catch (error) {
    console.error("Volunteers every-time claim failed", error instanceof Error ? error.name : "unknown");
    return { status: "error", reason: "unknown", message: refusalMessage("unknown"), fields: [] };
  }
  redirect(`/v/c/${manageToken}?new=1`);
}

/** Give back one date of an every-time claim (`claimId` set) or every date still ahead (empty). */
export async function cancelDateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const result = await cancelMySeries(getDb(), token, text(form, "claimId") || null, meta);
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/v", "layout");
  return { status: "ok", message: "Done. Thank you for letting us know." };
}
