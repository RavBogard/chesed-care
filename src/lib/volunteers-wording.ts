/**
 * The words of volunteer tasks that more than one screen uses: what each kind is called,
 * what a refused claim is told, and the share message. Every string here is listed for
 * Daniel in the pull request.
 */
import { CONGREGATION_NAME, CONGREGATION_SHORT } from "./brand";
import { publicRefusal } from "./public-wording";

export const KIND_WORDS = {
  visit: "Visit",
  call: "Call",
  meal: "Meal",
  ride: "Ride",
  shiva_minyan: "Shiva minyan",
  errand: "Errand",
  other: "Other",
} as const;
export type KindKey = keyof typeof KIND_WORDS;
export const KIND_ORDER: KindKey[] = ["visit", "call", "meal", "ride", "shiva_minyan", "errand", "other"];

/** Ready-made tasks on the new-task page: they only prefill the form; every field stays editable. `needed` is left empty where the poster should write it. */
export const QUICK_STARTS_LABEL = "Quick starts";
export const QUICK_STARTS: { key: string; label: string; kind: KindKey; needed: string; peopleNeeded: number }[] = [
  { key: "soup", label: `Soup from the ${CONGREGATION_SHORT} freezer`, kind: "errand", needed: `Pick up soup from the ${CONGREGATION_SHORT} freezer and drop it off.`, peopleNeeded: 1 },
  { key: "ride", label: "A ride to an appointment", kind: "ride", needed: "", peopleNeeded: 1 },
  { key: "meal", label: "A meal dropped off", kind: "meal", needed: "", peopleNeeded: 1 },
  { key: "visit", label: "A visit", kind: "visit", needed: "", peopleNeeded: 1 },
];

/** The link preview and the tab: nothing about who or what. */
export const PREVIEW_TITLE = "Can you help?";

/** The default line on a shiva sheet when the poster writes none. */
export const MINYAN_DEFAULT_NEEDED = "Please come to help make a minyan.";

/** The prefilled text and email: the link only, no personal details. */
export const SHARE_SUBJECT = "Can you help?";
export const shareBody = (url: string) => `Can you help? ${CONGREGATION_NAME} has a small request. Details and one tap to sign up: ${url}`;

export const placesWords = (left: number) => (left === 1 ? "1 place left" : `${left} places left`);
export const towardTen = (taken: number, needed: number) => `${taken} of ${needed}`;

/** The reasons a public action can be refused (the server's Refusal, plus a stale form). */
export type PublicReason = "not_found" | "full" | "past" | "closed" | "refused" | "rate_limited" | "invalid" | "stale" | "unknown";

const FIELD_WORDS: Record<string, string> = {
  firstName: "your first name",
  lastName: "your last name",
  contact: "your email or mobile number",
  note: "your note",
  line: "what you are bringing",
};

const OWN_REFUSALS: Partial<Record<PublicReason, string>> = {
  full: "Thank you. Every place has just been taken.",
  past: "That date has passed. Thank you for wanting to help.",
  closed: "This can no longer be changed.",
  not_found: "This link is no longer open. Thank you for wanting to help.",
};

/** The calm sentence for a refusal. `fields` are the names of the fields that were wrong, never their values. */
export const refusalMessage = (reason: PublicReason, fields: string[] = []): string => publicRefusal(reason, fields, OWN_REFUSALS, FIELD_WORDS);

/** The warning under a "what is needed" field that volunteers read. */
export const NEEDED_HELP = "One or two lines for volunteers. Please do not say why: no illness, no diagnosis, nothing from the care record.";
