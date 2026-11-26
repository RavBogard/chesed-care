/**
 * The words of Mitzvah Meals that more than one screen uses: kashrut in plain
 * language, what a night is called, and what a refused sign-up or change is told.
 * Every string here is listed for Daniel in the pull request.
 */
import { publicRefusal } from "./public-wording";

export const MEALS_NAME = "Mitzvah Meals";

export type Kashrut = "anything" | "kosher_style" | "vegetarian_or_dairy" | "strictly_kosher";

/** The four kashrut choices, in the words the family and the organiser pick from. */
export const KASHRUT_WORDS: Record<Kashrut, string> = {
  anything: "Anything is welcome",
  kosher_style: "Kosher style: no pork or shellfish, no meat with dairy",
  vegetarian_or_dairy: "Vegetarian or dairy only",
  strictly_kosher: "Strictly kosher: sealed, certified food or a kosher restaurant only",
};
export const KASHRUT_ORDER: Kashrut[] = ["anything", "kosher_style", "vegetarian_or_dairy", "strictly_kosher"];

export const DIETARY_CHOICES = ["gluten free", "vegetarian", "vegan", "pescatarian", "dairy free", "nut free", "egg free", "low salt", "soft foods"] as const;

export const FOOD_TYPE_WORDS = { meat: "Meat", dairy: "Dairy", pareve: "Pareve", not_sure: "Not sure yet" } as const;
export type FoodType = keyof typeof FOOD_TYPE_WORDS;

export const heading = (title: string) => `${MEALS_NAME} for ${title}`;

/** "Dinner" is the default and goes unsaid; a lunch is said. */
export const mealWord = (meal: "dinner" | "lunch") => (meal === "lunch" ? "Lunch" : "Dinner");

/** What a page that is not open says, kindly. Nothing else is shown. */
export const NOT_OPEN: Record<"draft" | "paused" | "ended", string> = {
  draft: "This page is not open yet. Please check back soon.",
  paused: "This page is resting for now. Thank you for wanting to help. Please check back later.",
  ended: "This page has ended. Thank you for your kindness.",
};

export const ALL_COVERED = "All covered. Gift cards still help.";

/** The reasons a public action can be refused (the server's Refusal, plus a stale form). */
export type PublicReason = "not_found" | "closed" | "refused" | "rate_limited" | "invalid" | "unavailable" | "taken" | "stale" | "unknown";

const FIELD_WORDS: Record<string, string> = {
  firstName: "your first name",
  lastName: "your last name",
  email: "your email address",
  kind: "whether you will cook or send a delivery",
  bringing: "what you are bringing",
  foodType: "meat, dairy or pareve",
  note: "your note",
  text: "your message",
  title: "the name of the family",
  date: "the date",
};

const OWN_REFUSALS: Partial<Record<PublicReason, string>> = {
  taken: "Someone has just taken that night. Please choose another.",
  unavailable: "That night is no longer open. Please choose another.",
  closed: "This page is not taking changes right now.",
  not_found: "This link is not working. Please ask whoever sent it to you for a new one.",
};

/** The calm sentence for a refusal. `fields` are the names of the fields that were wrong, never their values. */
export const refusalMessage = (reason: PublicReason, fields: string[] = []): string => publicRefusal(reason, fields, OWN_REFUSALS, FIELD_WORDS);

export const ETIQUETTE = [
  "Please bring the food in disposable containers, so nothing needs returning.",
  "Label what is in it, and whether it is meat, dairy or pareve.",
  "Add a note for reheating if it needs one.",
  "Drop it off and go, unless you have been asked to stay.",
];

/** "Ruth Cohen" becomes "the Cohen family". The organiser may change it. */
export const familyTitle = (name: string) => {
  const last = name.trim().split(/\s+/).at(-1);
  return last ? `the ${last} family` : "";
};
