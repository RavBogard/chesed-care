/**
 * A person's own Today choices for the dates: one kind at a time, and whether birthdays are
 * hidden. Stored on their user row, so they follow the person to any device. Nothing else.
 */
import { eq } from "drizzle-orm";
import { canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import { users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { InvalidInput } from "./validate";

export const TODAY_KINDS = ["yahrzeit", "shloshim", "birthday", "anniversary"] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];
export type TodayPrefs = { kind: TodayKind | null; hideBirthdays: boolean };
export const DEFAULT_TODAY_PREFS: TodayPrefs = { kind: null, hideBirthdays: false };

function clean(raw: unknown): TodayPrefs {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { kind: (TODAY_KINDS as readonly unknown[]).includes(v.kind) ? (v.kind as TodayKind) : null, hideBirthdays: v.hideBirthdays === true };
}

export async function getTodayPrefs(db: Db, actor: Actor): Promise<TodayPrefs> {
  if (!canSeeLifecycle(actor)) return DEFAULT_TODAY_PREFS;
  const [row] = await db.select({ prefs: users.todayPrefs }).from(users).where(eq(users.id, actor.id)).limit(1);
  return clean(row?.prefs);
}

export async function setTodayPrefs(db: Db, actor: Actor, input: { kind: unknown; hideBirthdays: unknown }): Promise<TodayPrefs> {
  if (!canSeeLifecycle(actor)) deny();
  if (input.kind !== null && !(TODAY_KINDS as readonly unknown[]).includes(input.kind)) throw new InvalidInput("kind");
  if (typeof input.hideBirthdays !== "boolean") throw new InvalidInput("hideBirthdays");
  const prefs = clean(input);
  await db.update(users).set({ todayPrefs: prefs }).where(eq(users.id, actor.id));
  return prefs;
}
