/**
 * Each user's own text drafts, one per occasion type. Only the user reads or writes
 * their own; the defaults stay in code (src/server/lifecycle/sms.ts).
 */
import { and, eq } from "drizzle-orm";
import { canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import { textDrafts } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import type { OccasionType } from "@/server/lifecycle/types";
import { oneOf, optionalText } from "./validate";

export const OCCASION_TYPES = ["yahrzeit", "shloshim", "birthday", "anniversary"] as const;
export const DRAFT_MAX = 500;

export type OwnDrafts = Partial<Record<OccasionType, string>>;

export async function getTextDrafts(db: Db, actor: Actor): Promise<OwnDrafts> {
  if (!canSeeLifecycle(actor)) return {};
  const rows = await db.select().from(textDrafts).where(eq(textDrafts.userId, actor.id));
  return Object.fromEntries(rows.map((r) => [r.occasionType, r.body]));
}

/** Save the actor's draft for one type; a blank body returns that type to the default. */
export async function setTextDraft(db: Db, actor: Actor, input: { occasionType: unknown; body: unknown }): Promise<void> {
  if (!canSeeLifecycle(actor)) deny();
  const occasionType = oneOf(input.occasionType, "occasionType", OCCASION_TYPES);
  const body = optionalText(input.body, "body", DRAFT_MAX);
  if (body === null) {
    await db.delete(textDrafts).where(and(eq(textDrafts.userId, actor.id), eq(textDrafts.occasionType, occasionType)));
    return;
  }
  await db
    .insert(textDrafts)
    .values({ userId: actor.id, occasionType, body })
    .onConflictDoUpdate({ target: [textDrafts.userId, textDrafts.occasionType], set: { body, updatedAt: new Date() } });
}
