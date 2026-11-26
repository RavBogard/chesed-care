/**
 * The old sheet's offer columns, mapped onto the roster's can-do list (src/lib/can-do.ts) where the app has a matching
 * category. Where it has none, the column's own label is kept as words on the member ("Walk dog"), never a new category.
 * `keep: true` keeps the label as well, when the category alone would lose something ("Gluten-free meal" is a meal).
 * Matched on the start of the header after headerKey(): line breaks and punctuation do not matter.
 */
import type { CanDo } from "@/lib/can-do";
import { headerKey } from "./cells";

export type OfferRule = { needle: string; canDo: CanDo | null; label: string; keep?: boolean };

/** "MC Volunteers": a column per offer, marked "X" or with words. */
export const SHEET_OFFERS: readonly OfferRule[] = [
  { needle: "bake challah", canDo: "baking", label: "Bake challah, sweets" },
  { needle: "make meals", canDo: "meals", label: "Make meals" },
  { needle: "make soup", canDo: "soup", label: "Make soup" },
  { needle: "nursing home visits", canDo: "visits", label: "Nursing home visits", keep: true },
  { needle: "home or hosp", canDo: "visits", label: "Home or hospital visits" },
  { needle: "care pkg", canDo: "care_packages", label: "Care package to hospital" },
  { needle: "walk dog", canDo: "pet_care", label: "Walk dog", keep: true },
  { needle: "errands", canDo: "errands", label: "Errands, grocery shop" },
  { needle: "drive", canDo: "rides", label: "Drive" },
  { needle: "shiva", canDo: "shiva_help", label: "Shiva" },
  { needle: "deliver soup", canDo: "deliveries", label: "Deliver soup etc." },
  { needle: "other care", canDo: "other", label: "Other care, tasks" },
  { needle: "support calls", canDo: "calls", label: "Support calls" },
  { needle: "pay for meal", canDo: null, label: "Pay for a meal" },
];

/** "Volunteer Form Responses": "How can you help? [<offer>]", answered "Yes". Matched on the words in the brackets. */
export const FORM_OFFERS: readonly OfferRule[] = [
  { needle: "bake challah", canDo: "baking", label: "Bake challah or sweets" },
  { needle: "provide a meal", canDo: "meals", label: "Provide a meal" },
  { needle: "provide a vegetarian", canDo: "meals", label: "Vegetarian or vegan meal", keep: true },
  { needle: "provide a gluten", canDo: "meals", label: "Gluten-free meal", keep: true },
  { needle: "pay for meal", canDo: null, label: "Pay for meal delivery" },
  { needle: "deliver chicken soup", canDo: "deliveries", label: "Deliver soup, challah or a meal" },
  { needle: "provide and deliver care", canDo: "care_packages", label: "Care package" },
  { needle: "pet sit", canDo: "pet_care", label: "Pet sit", keep: true },
  { needle: "walk dog", canDo: "pet_care", label: "Walk dog", keep: true },
  { needle: "grocery shop", canDo: "errands", label: "Grocery shop or errands" },
  { needle: "set up shiva", canDo: "shiva_help", label: "Set up shiva or receive deliveries" },
  { needle: "drive a member", canDo: "rides", label: "Drive to an appointment or CRC" },
  { needle: "make supportive", canDo: "calls", label: "Supportive phone calls" },
  { needle: "provide tech", canDo: "tech_help", label: "Tech support" },
  { needle: "other caring", canDo: "other", label: "Other caring tasks" },
  { needle: "helping new parents", canDo: null, label: "Helping new parents" },
];

/** The rule for a header, or null when the sheet has an offer the app does not know. */
export function offerRule(rules: readonly OfferRule[], header: string): OfferRule | null {
  const key = headerKey(header);
  return rules.find((r) => key.startsWith(r.needle) || key.includes(r.needle)) ?? null;
}
