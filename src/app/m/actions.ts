"use server";

/**
 * The public Mitzvah Meals actions: no account, so there is no viewer to resolve. Each
 * is keyed by a secret link the caller holds, and each builds its own clientMeta on the
 * server from the platform's address and a server-signed render time (never from
 * anything the browser sends about itself). They log nothing: no names, emails,
 * addresses, tokens or free text.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { refusalMessage, type PublicReason } from "@/lib/meals-wording";
import { mealSignupMail } from "@/lib/email-wording";
import { getDb } from "@/server/db/client";
import { afterEmail, sendEmail } from "@/server/email/send";
import { appOrigin } from "@/server/env";
import { elapsedSinceStamp } from "@/server/meals/client-meta";
import { familyEnd, familyPause, familyResume, thankHelper, updateFoodNeeds } from "@/server/meals/family";
import { clientMeta, refusals, text } from "@/server/public/form";
import { cancelMySignup, changeMySignup, signUpForMeal, type Refused } from "@/server/meals/public";

export type SignupState = { status: "idle" } | { status: "error"; message: string; reason: PublicReason; fields: string[] };

const { failed, trouble, stale, unknown: NO_ADDRESS } = refusals<Refused["reason"]>("Meals action failed", refusalMessage);

/** Sign up for a night. On success: straight to the helper's own page, which holds the address, the calendar file and the link to change or cancel. */
export async function signUpAction(_prev: SignupState, form: FormData): Promise<SignupState> {
  const token = text(form, "token");
  let manageToken: string;
  try {
    // A missing, forged or day-old stamp is a form that was not rendered by us a short while ago.
    if (elapsedSinceStamp(text(form, "stamp"), token, new Date()) === null) return stale();
    const meta = await clientMeta(token, form, true);
    if (!meta) return { status: "error", reason: "refused", message: refusalMessage("refused"), fields: [] };
    const result = await signUpForMeal(
      getDb(),
      token,
      text(form, "slotId"),
      {
        firstName: text(form, "firstName"),
        lastName: text(form, "lastName"),
        email: text(form, "email"),
        kind: text(form, "kind"),
        bringing: text(form, "bringing"),
        foodType: text(form, "foodType") || "not_sure",
        note: text(form, "note"),
        mayContactAgain: text(form, "mayContactAgain") === "on",
      },
      meta,
    );
    if (!result.ok) return { status: "error", reason: result.reason, message: refusalMessage(result.reason, result.fields), fields: result.fields ?? [] };
    manageToken = result.manageToken;
    // The confirmation says only the date and the link to the helper's own page.
    const db = getDb();
    const { signupId, details, manageToken: mine } = result;
    const to = text(form, "email").trim().toLowerCase();
    afterEmail(async () => {
      await sendEmail(db, { to, ...mealSignupMail({ date: details.date, pageUrl: `${appOrigin()}/m/s/${mine}` }), kind: "meal_signup", ref: signupId });
    });
  } catch (error) {
    console.error("Meals sign-up failed", error instanceof Error ? error.name : "unknown");
    return { status: "error", reason: "unknown", message: refusalMessage("unknown"), fields: [] };
  }
  redirect(`/m/s/${manageToken}?new=1`);
}

/** Change what a helper is bringing, or move to another night. */
export async function changeSignupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const move = text(form, "moveToSlotId");
    const result = await changeMySignup(
      getDb(),
      token,
      {
        ...(text(form, "kind") ? { kind: text(form, "kind") } : {}),
        bringing: text(form, "bringing"),
        ...(text(form, "foodType") ? { foodType: text(form, "foodType") } : {}),
        note: text(form, "note"),
        ...(move ? { moveToSlotId: move } : {}),
      },
      meta,
    );
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/m", "layout");
  return { status: "ok", message: "Saved." };
}

export async function cancelSignupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const result = await cancelMySignup(getDb(), token, meta);
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/m", "layout");
  return { status: "ok", message: "Your night has been given back. Thank you for letting us know." };
}

/** The family's food needs: kashrut, dietary needs, allergies, who is eating, the drop-off window and instructions. */
export async function familyFoodAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const custom = text(form, "dietaryOther")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const result = await updateFoodNeeds(
      getDb(),
      token,
      {
        foodFor: text(form, "foodFor"),
        kashrut: text(form, "kashrut"),
        dietary: [...form.getAll("dietary").filter((v): v is string => typeof v === "string"), ...custom],
        allergies: text(form, "allergies"),
        dropOffWindow: text(form, "dropOffWindow"),
        dropOffInstructions: text(form, "dropOffInstructions"),
      },
      meta,
    );
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/m", "layout");
  return { status: "ok", message: "Saved. Everyone who signs up from now on will see this." };
}

const STATUS = { pause: familyPause, resume: familyResume, end: familyEnd } as const;
const STATUS_DONE = { pause: "The page is paused. Nobody can sign up until it is resumed.", resume: "The page is open again.", end: "The page has ended. Thank you for letting us help." } as const;

/** Pause, resume or end the page, from the family's own link. */
export async function familyStatusAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  const op = text(form, "op");
  if (!(op in STATUS)) return NO_ADDRESS;
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const result = await STATUS[op as keyof typeof STATUS](getDb(), token, meta);
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/m", "layout");
  return { status: "ok", message: STATUS_DONE[op as keyof typeof STATUS_DONE] };
}

/** A line of thanks to one helper, shown to them on their own page. */
export async function thankHelperAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = text(form, "token");
  try {
    const meta = await clientMeta(token, form, false);
    if (!meta) return failed({ reason: "refused" });
    const result = await thankHelper(getDb(), token, text(form, "signupId"), text(form, "text"), meta);
    if (!result.ok) return failed(result);
  } catch (error) {
    return trouble(error);
  }
  revalidatePath("/m", "layout");
  return { status: "ok", message: "Sent. They will see it on their page." };
}
