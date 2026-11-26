import { and, eq, lt } from "drizzle-orm";
import { sfDayCache } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays } from "@/server/lifecycle/window";

const KEEP_DAYS = 7;

/**
 * Version of the shape of what is cached. Raise it whenever a fetcher starts returning new or
 * changed fields, so rows cached earlier the same day by older code are not served in the new shape.
 */
export const CACHE_SHAPE = "v5";

/**
 * Return the value cached for (key, day), or fetch it, store it and return it.
 * `day` is the congregation's calendar day, so the first visitor each day pays
 * for the Salesforce read and everyone after reads the stored copy. A failed
 * fetch is not cached. Rows older than a week are pruned on write.
 */
export async function cachedForDay<T>(db: Db, key: string, day: string, fetcher: () => Promise<T>): Promise<T> {
  const [hit] = await db
    .select({ data: sfDayCache.data })
    .from(sfDayCache)
    .where(and(eq(sfDayCache.key, key), eq(sfDayCache.day, day)))
    .limit(1);
  if (hit) return hit.data as T;
  const data = await fetcher();
  await db
    .insert(sfDayCache)
    .values({ key, day, data })
    .onConflictDoUpdate({ target: [sfDayCache.key, sfDayCache.day], set: { data, fetchedAt: new Date() } });
  await db.delete(sfDayCache).where(lt(sfDayCache.day, addDays(day, -KEEP_DAYS)));
  return data;
}
