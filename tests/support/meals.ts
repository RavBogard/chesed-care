import type { Actor } from "@/server/access/policy";
import type { Db } from "@/server/db/types";
import { createMealPage, goLive, markFamilyAgreed, type MealPageForOrganiser } from "@/server/meals/pages";

/** Tuesday 1 December 2026, noon in St. Louis. */
export const NOW = new Date("2026-12-01T18:00:00Z");
export const TODAY = "2026-12-01";

export const ADDRESS = "12 Maple Lane, St. Louis";
export const INSTRUCTIONS = "Cooler on the porch, please do not knock";

export const pageInput = (over: Record<string, unknown> = {}) => ({
  title: "the Cohen family",
  note: "Thank you for helping",
  foodFor: "2 adults, 3 children",
  kashrut: "kosher_style",
  dietary: ["nut free"],
  allergies: "Peanuts",
  dropOffWindow: "5 to 6 pm",
  dropOffInstructions: INSTRUCTIONS,
  dropOffAddress: ADDRESS,
  deliveryPlaces: "Pi Pizzeria",
  giftCards: "Schnucks",
  giftCardEmail: "cohens@example.test",
  dates: [{ date: "2026-12-01" }, { date: "2026-12-03" }, { date: "2026-12-05" }],
  ...over,
});

/** A page as its organiser sees it before any purge: both links are there. */
export type LivePage = MealPageForOrganiser & { publicToken: string; familyToken: string };

export async function livePage(db: Db, actor: Actor, over: Record<string, unknown> = {}): Promise<LivePage> {
  const page = await createMealPage(db, actor, pageInput(over), NOW);
  await markFamilyAgreed(db, actor, page.id, NOW);
  const live = await goLive(db, actor, page.id, NOW);
  if (!live.publicToken || !live.familyToken) throw new Error("the organiser was not given both links");
  return live as LivePage;
}

let client = 0;
/** A believable browser: a fresh client each call unless a key is given. */
export const meta = (clientKey = `198.51.100.${++client}`) => ({ clientKey, honeypot: "", elapsedMs: 9_000 });

export const helper = (over: Record<string, unknown> = {}) => ({
  firstName: "Dana",
  lastName: "Levy",
  email: "Dana.Levy@Example.test",
  kind: "cook",
  bringing: "Lasagne",
  foodType: "dairy",
  note: "See you at six",
  mayContactAgain: false,
  ...over,
});
