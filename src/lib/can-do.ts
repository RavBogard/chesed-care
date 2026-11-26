/** What a Mitzvah Corps member can do, and what each kind of task asks. Plain data, safe for server and browser code alike. */
export const CAN_DO = ["visits", "calls", "meals", "rides", "shiva_minyan", "shiva_help", "errands", "deliveries", "soup", "baking", "care_packages", "house_sitting", "pet_care", "tech_help", "other"] as const;
export type CanDo = (typeof CAN_DO)[number];

/** What a task of each kind asks of a member. */
export const CAN_DO_FOR_KIND = { visit: "visits", call: "calls", meal: "meals", ride: "rides", shiva_minyan: "shiva_minyan", shiva_help: "shiva_help", errand: "errands", delivery: "deliveries", pet_care: "pet_care", tech_help: "tech_help", other: "other" } as const satisfies Record<string, CanDo>;

/** How often a member would like to be asked, and how they prefer to hear from us (both optional). */
export const HOW_OFTEN = ["once_a_year", "twice_a_year", "quarterly", "monthly", "as_needed"] as const;
export type HowOften = (typeof HOW_OFTEN)[number];
export const PREFER_CONTACT = ["email", "text", "call"] as const;
export type PreferContact = (typeof PREFER_CONTACT)[number];
/** Days that must pass after someone was last asked before they are asked again. as_needed (and nothing chosen) never waits. */
export const HOW_OFTEN_DAYS: Record<HowOften, number> = { once_a_year: 365, twice_a_year: 182, quarterly: 91, monthly: 30, as_needed: 0 };
