"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AccessDenied } from "@/server/access/policy";
import { fields, runAction, runData } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { InvalidInput } from "@/server/care/validate";
import { resolveHouseholdName, searchHouseholdNames, type HouseholdName } from "@/server/lifecycle/household-names";
import { addCoOrganiser, createMealPage, endMealPage, goLive, markFamilyAgreed, pauseMealPage, removeCoOrganiser, resumeMealPage, updateMealPage } from "@/server/meals/pages";
import { addDates, bookOnBehalf, removeSignup, withdrawDate } from "@/server/meals/slots";
import { getSalesforce } from "@/server/salesforce";
import type { ActionState } from "@/lib/action-state";

const list = (form: FormData, name: string) => form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");
const dates = (form: FormData) => list(form, "date").map((date) => ({ date, meal: "dinner" as const }));

export type HouseholdSearch = { status: "idle" } | { status: "results"; results: HouseholdName[] } | { status: "error"; message: string };

/** Search member households by name, by POST so the name is never in a URL. Only names come back. */
export async function searchHouseholdsAction(_prev: HouseholdSearch, form: FormData): Promise<HouseholdSearch> {
  const viewer = await getViewer();
  if (viewer.kind !== "ok") return { status: "error", message: "Please sign in again." };
  try {
    return { status: "results", results: await searchHouseholdNames({ sf: getSalesforce }, viewer.actor, form.get("q")) };
  } catch (error) {
    if (error instanceof AccessDenied) return { status: "error", message: "You do not have access to do that." };
    if (error instanceof InvalidInput) return { status: "error", message: "Please use at least two letters, and only letters in the name." };
    console.error("Meals: household search unavailable", error instanceof Error ? error.name : "unknown");
    return { status: "error", message: "Salesforce could not be reached just now. Try again in a minute." };
  }
}

/**
 * Start a page: who it is for (a household chosen by search, a care item, or an outside
 * person; the name behind a Contact Id is read from Salesforce, never taken from the form),
 * the dates, and whether the family has said yes. Then to the page.
 */
export async function createMealsPageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  const result = await runData(await getViewer(), async (actor, db) => {
    let subject: Record<string, unknown> = {};
    if (f.careItemId) subject = { careItemId: f.careItemId };
    else if (f.outsidePersonId) subject = { outsidePersonId: f.outsidePersonId };
    else if (f.contactId) {
      const who = await resolveHouseholdName({ sf: getSalesforce }, actor, f.contactId);
      subject = { sfContactId: who.contactId, ...(who.accountId ? { sfAccountId: who.accountId } : {}) };
    }
    const page = await createMealPage(db, actor, { title: f.title ?? "", ...subject, dates: dates(form) });
    if (f.agreed === "on") await markFamilyAgreed(db, actor, page.id);
    return { id: page.id };
  });
  if (result.status === "error") return result;
  revalidatePath("/meals");
  redirect(`/meals/${result.data.id}`);
}

/** Words, food needs and where the food goes. */
export async function updateDetailsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const custom = (f.dietaryOther ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    await updateMealPage(db, actor, f.pageId, {
      title: f.title ?? "",
      note: f.note ?? "",
      foodFor: f.foodFor ?? "",
      kashrut: f.kashrut ?? "anything",
      dietary: [...list(form, "dietary"), ...custom],
      allergies: f.allergies ?? "",
      dropOffWindow: f.dropOffWindow ?? "",
      dropOffInstructions: f.dropOffInstructions ?? "",
      dropOffAddress: f.dropOffAddress ?? "",
      dropOffIsHome: f.dropOffIsHome === "yes",
      deliveryPlaces: f.deliveryPlaces ?? "",
      giftCards: f.giftCards ?? "",
      giftCardEmail: f.giftCardEmail ?? "",
    });
    return "Saved.";
  });
}

export async function agreedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await markFamilyAgreed(db, actor, f.pageId);
    return "Noted. The page can go live.";
  });
}

const STATUS = { live: [goLive, "The page is live. Share the link."], pause: [pauseMealPage, "The page is paused."], resume: [resumeMealPage, "The page is live again."], end: [endMealPage, "The page has ended."] } as const;

/** Go live, pause, resume or end. */
export async function statusAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  const op = f.op ?? "";
  return runAction(await getViewer(), async (actor, db) => {
    if (!(op in STATUS)) throw new InvalidInput("op");
    const [run, message] = STATUS[op as keyof typeof STATUS];
    await run(db, actor, f.pageId);
    return message;
  });
}

export async function addDatesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await addDates(db, actor, f.pageId, dates(form));
    return "Dates added.";
  });
}

export async function withdrawDateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await withdrawDate(db, actor, f.pageId, f.slotId);
    return "Taken off the page.";
  });
}

export async function bookOnBehalfAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await bookOnBehalf(db, actor, f.pageId, f.slotId, {
      firstName: f.firstName ?? "",
      lastName: f.lastName ?? "",
      email: f.email ?? "",
      kind: f.kind ?? "cook",
      bringing: f.bringing ?? "",
      foodType: f.foodType ?? "not_sure",
      note: "",
      mayContactAgain: false,
    });
    return "Booked.";
  });
}

export async function removeSignupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await removeSignup(db, actor, f.pageId, f.signupId, { blockEmail: f.blockEmail === "on" });
    return "Removed. The night is open again.";
  });
}

export async function coOrganiserAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    if (f.op === "remove") {
      await removeCoOrganiser(db, actor, f.pageId, f.userId);
      return "Removed.";
    }
    await addCoOrganiser(db, actor, f.pageId, f.userId);
    return "Added. They can see and run this page.";
  });
}
