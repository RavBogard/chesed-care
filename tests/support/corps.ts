import type { Db } from "@/server/db/types";
import { signUpForMeal } from "@/server/meals/public";
import { helper, meta, NOW, type LivePage } from "./meals";

/** A helper signs up for the page's slot on `date` (the page was made with 1, 3 and 5 December). */
export async function signUp(db: Db, page: LivePage, email: string, date: string, mayContactAgain = false, now = NOW) {
  const open = (await import("@/server/db/schema")).mealSlots;
  const { eq, and } = await import("drizzle-orm");
  const [slot] = await db.select({ id: open.id }).from(open).where(and(eq(open.pageId, page.id), eq(open.date, date)));
  const r = await signUpForMeal(db, page.publicToken, slot.id, helper({ email, mayContactAgain }), meta(), now);
  if (!r.ok) throw new Error(`sign-up refused: ${r.reason}`);
  return r;
}
