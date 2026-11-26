"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { CLOSED_OK, CONSENT_SAVED, REFER_SENT, TAKE_WAITS, TAKEN_ALREADY, TAKEN_OK, WITHDRAWN_OK } from "@/lib/referral-wording";
import { fields, runAction, runData } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { getSalesforce } from "@/server/salesforce";
import { closeReferral, createReferral, setReferralConsent, takeReferral, withdrawReferral } from "@/server/volunteers/referrals";

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v);

/** Clergy refer a person to Mitzvah Corps (from their page). The name is read on the server. */
export async function referToCorpsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await createReferral(
      db,
      actor,
      { sfContactId: blank(f.sfContactId), outsidePersonId: blank(f.outsidePersonId), kind: f.kind, consent: f.consent, contactLine: blank(f.contactLine), mayShareAddress: f.mayShareAddress === "on", alreadyInvolved: blank(f.alreadyInvolved), note: blank(f.note) },
      { sf: getSalesforce },
    );
    return REFER_SENT;
  });
}

export async function withdrawReferralAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await withdrawReferral(db, actor, f.referralId);
    return WITHDRAWN_OK;
  });
}

/** A rabbi has now asked the person: the coordinator may go ahead, or should ask them. */
export async function setReferralConsentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await setReferralConsent(db, actor, f.referralId, f.consent);
    return CONSENT_SAVED;
  });
}

/** "I'll take this" on a referral. The first to press wins; the other is told it is taken. */
export async function takeReferralAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  const result = await runData(await getViewer(), (actor, db) => takeReferral(db, actor, f.referralId));
  if (result.status === "error") return result;
  revalidatePath("/volunteers");
  if (result.data.ok) return { status: "ok", message: TAKEN_OK };
  return { status: "error", message: result.data.reason === "rabbi_asks_first" ? TAKE_WAITS : TAKEN_ALREADY };
}

/** Whoever took it: done (with an optional line for the clergy), or the person said no thank you. */
export async function closeReferralAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await closeReferral(db, actor, f.referralId, { as: f.as, outcomeLine: blank(f.outcome) });
    return CLOSED_OK;
  });
}
