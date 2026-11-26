/**
 * The meals line on a person, for clergy: for each page about them that the actor
 * may see, its status, the date it is covered through and how many dates are open.
 * A page linked to a restricted care item the actor cannot read is simply absent.
 */
import { and, desc, eq, ne, or, type SQL } from "drizzle-orm";
import { canSeeMealsLine, deny, mealPageVisibleWhere, type Actor } from "@/server/access/policy";
import { contactIdField, InvalidInput, optionalAccountIdField, uuidField } from "@/server/care/validate";
import { mealPages } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { coverageOf, loadSlots, type MealPageStatus } from "./core";

export type MealsLine = { pageId: string; title: string; status: MealPageStatus; coveredThrough: string | null; openDates: number };

/** Give sfContactId (and sfAccountId to include the household's pages) or outsidePersonId. Ended pages are left out. */
export async function mealsLineForPerson(db: Db, actor: Actor, person: { sfContactId?: unknown; sfAccountId?: unknown; outsidePersonId?: unknown }, now: Date = new Date()): Promise<MealsLine[]> {
  if (!canSeeMealsLine(actor)) deny();
  const who: SQL[] = [];
  if (person.sfContactId) who.push(eq(mealPages.sfContactId, contactIdField(person.sfContactId)));
  const account = optionalAccountIdField(person.sfAccountId);
  if (account) who.push(eq(mealPages.sfAccountId, account));
  if (person.outsidePersonId) who.push(eq(mealPages.outsidePersonId, uuidField(person.outsidePersonId, "outsidePersonId")));
  if (who.length === 0) throw new InvalidInput("person");
  const pages = await db
    .select({ id: mealPages.id, title: mealPages.title, status: mealPages.status })
    .from(mealPages)
    .where(and(or(...who), ne(mealPages.status, "ended"), mealPageVisibleWhere(actor)))
    .orderBy(desc(mealPages.createdAt));
  const today = chicagoToday(now);
  const rows = await loadSlots(db, pages.map((p) => p.id));
  return pages.map((p) => {
    const { coveredThrough, openDates } = coverageOf(rows.filter((r) => r.slot.pageId === p.id), today);
    return { pageId: p.id, title: p.title, status: p.status, coveredThrough, openDates };
  });
}
