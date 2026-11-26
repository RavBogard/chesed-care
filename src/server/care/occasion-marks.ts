import { and, eq } from "drizzle-orm";
import { canMarkOccasion, canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import { occasionMarks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { assertSfId, InvalidSalesforceId } from "@/server/salesforce/ids";
import { InvalidInput, oneOf, optionalAccountIdField } from "./validate";

const TYPES = ["yahrzeit", "shloshim", "birthday", "anniversary"] as const;
export type OccasionMark = typeof occasionMarks.$inferSelect;

/** The key a mark and an occasion row share: type, source record, household, year. */
export function markKey(m: { occasionType: string; subjectId: string; sfAccountId: string | null; year: number }): string {
  return `${m.occasionType}|${m.subjectId}|${m.sfAccountId ?? ""}|${m.year}`;
}

function sfIdField(v: unknown, field: string): string {
  try {
    return assertSfId(v);
  } catch (e) {
    if (e instanceof InvalidSalesforceId) throw new InvalidInput(field);
    throw e;
  }
}

function yearField(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 2000 || v > 2200) throw new InvalidInput("year");
  return v;
}

/** "Done for this year": shared by the team, so one tap by anyone marks it for everyone. Idempotent. */
export async function markOccasion(
  db: Db,
  actor: Actor,
  input: { occasionType: unknown; subjectId: unknown; sfAccountId?: unknown; sfContactId?: unknown; year: unknown },
): Promise<void> {
  if (!canMarkOccasion(actor)) deny();
  const values = {
    occasionType: oneOf(input.occasionType, "occasionType", TYPES),
    subjectId: sfIdField(input.subjectId, "subjectId"),
    sfAccountId: optionalAccountIdField(input.sfAccountId) ?? "",
    sfContactId: input.sfContactId === undefined || input.sfContactId === null || input.sfContactId === "" ? null : sfIdField(input.sfContactId, "sfContactId"),
    year: yearField(input.year),
    markedBy: actor.id,
  };
  await db.insert(occasionMarks).values(values).onConflictDoNothing();
}

export async function unmarkOccasion(db: Db, actor: Actor, input: { occasionType: unknown; subjectId: unknown; sfAccountId?: unknown; year: unknown }): Promise<void> {
  if (!canMarkOccasion(actor)) deny();
  await db
    .delete(occasionMarks)
    .where(
      and(
        eq(occasionMarks.occasionType, oneOf(input.occasionType, "occasionType", TYPES)),
        eq(occasionMarks.subjectId, sfIdField(input.subjectId, "subjectId")),
        eq(occasionMarks.sfAccountId, optionalAccountIdField(input.sfAccountId) ?? ""),
        eq(occasionMarks.year, yearField(input.year)),
      ),
    );
}

/** The marks for a set of years, as keys (see markKey). */
export async function listMarkKeys(db: Db, actor: Actor, years: number[]): Promise<Set<string>> {
  if (!canSeeLifecycle(actor)) deny();
  const out = new Set<string>();
  for (const year of [...new Set(years.map(yearField))]) {
    const rows = await db.select().from(occasionMarks).where(eq(occasionMarks.year, year));
    for (const r of rows) out.add(markKey(r));
  }
  return out;
}
