/**
 * Adding directly, for staff and Mitzvah Corps leads (canAddDirectly): a member straight onto a rabbi's care list, and
 * a name straight onto the Mi Sheberach list. Nothing waits in the Inbox.
 *
 * It is write-only. The person is chosen by the name-only member search, which reads no care record. A new care item
 * is always made, whatever the person already has, so the answer never says whether anyone is in care, and a
 * restricted item stays unknown. Staff see neither list afterwards. Audit rows hold ids only.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { canAddDirectly, deny, type Actor } from "@/server/access/policy";
import { proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { resolveHouseholdName } from "@/server/lifecycle/household-names";
import { chicagoToday } from "@/server/lifecycle/window";
import { withinDailyLimit, withinLimit } from "@/server/meals/rate-limit";
import { addRequestedName } from "@/server/misheberach/list";
import { listAwayToday } from "@/server/team/away";
import type { SalesforceClient } from "@/server/salesforce/client";
import { writeAudit } from "./audit";
import { CARE_CATEGORIES, writeCareItem } from "./care-items";
import { InvalidInput, oneOf, text, TooMany, uuidField } from "./validate";

/** One person's additions, per hour and per day, for each of the two lists: far above a busy office day, far below a loop. */
export const STAFF_ADD_LIMITS = { perHour: 20, perDay: 60 } as const;

async function allow(db: Db, actor: Actor, what: "care" | "mi", now: Date): Promise<void> {
  const key = `staff-add:${what}:${actor.id}`;
  if (!(await withinLimit(db, key, STAFF_ADD_LIMITS.perHour, now)) || !(await withinDailyLimit(db, `day:${key}`, STAFF_ADD_LIMITS.perDay, now))) throw new TooMany();
}

export type ClergyChoice = { id: string; name: string; away: boolean };

const clergyWhere = and(eq(users.active, true), inArray(users.role, ["owner", "clergy"]));

/** The rabbis a care item can go to: a name, an id and whether they are away today, nothing else. */
export async function listClergyChoices(db: Db, actor: Actor, now: Date = new Date()): Promise<ClergyChoice[]> {
  if (!canAddDirectly(actor)) deny();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(clergyWhere).orderBy(asc(users.name));
  const away = new Set((await listAwayToday(db, chicagoToday(now))).map((a) => a.userId));
  return rows.map((r) => ({ id: r.id, name: r.name ?? "A member of the clergy", away: away.has(r.id) }));
}

export type StaffCareInput = { contactId: unknown; ownerUserId: unknown; category: unknown; words: unknown; sensitive?: unknown };

/**
 * Put a member on a rabbi's care list at once: a new care item, new and unassigned to anyone else, with the staff
 * member's words as its summary. "Sensitive" makes it restricted to that rabbi alone.
 */
export async function staffAddCareItem(deps: { db: Db; sf: () => SalesforceClient; now?: Date }, actor: Actor, input: StaffCareInput): Promise<{ careItemId: string; ownerUserId: string; ownerName: string }> {
  if (!canAddDirectly(actor)) deny();
  const now = deps.now ?? new Date();
  const ownerUserId = uuidField(input.ownerUserId, "ownerUserId");
  const category = oneOf(input.category, "category", CARE_CATEGORIES);
  const words = text(input.words, "words", 500);
  const restricted = input.sensitive === true;
  // Restricted to a rabbi who is away would be seen by no one: whoever covers cannot open it.
  if (restricted && (await listAwayToday(deps.db, chicagoToday(now))).some((a) => a.userId === ownerUserId)) throw new InvalidInput("sensitive");
  // The name and household are read from Salesforce by the chosen Id; a form cannot supply them.
  const who = await resolveHouseholdName(deps, actor, input.contactId);
  // Counted once everything checks out, so a typo does not use up the hour. (The Mi Sheberach limit counts every try, so that a barred name looks no different.)
  await allow(deps.db, actor, "care", now);
  return deps.db.transaction(async (tx) => {
    // writeCareItem refuses an owner who is not active clergy.
    const item = await writeCareItem(tx, actor, { sfContactId: who.contactId, sfAccountId: who.accountId ?? undefined, displayName: who.name, category, summary: words, learnedFrom: actor.name ?? "Staff", source: "staff", ownerUserId, restricted });
    await writeAudit(tx, actor, "care_item.staff_add", "care_item", item.id, { restricted });
    const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ownerUserId)).limit(1);
    return { careItemId: item.id, ownerUserId, ownerName: owner?.name ?? "the clergy" };
  });
}

/**
 * Put a name on the Mi Sheberach list at once, not yet confirmed. A name a rabbi must decide about (its person once
 * asked not to be listed) is not added: it goes to the shared Inbox with no submitter, so it never shows among the staff
 * member's own reports, and the answer is the same as for a name that went on. Staff cannot tell the two apart.
 */
export async function staffAddMiSheberach(db: Db, actor: Actor, input: { name: unknown; askedBy?: unknown }, now: Date = new Date()): Promise<{ result: "taken" | "already"; proposalId?: string }> {
  if (!canAddDirectly(actor)) deny();
  await allow(db, actor, "mi", now);
  const result = await addRequestedName(db, actor, { name: input.name, askedBy: input.askedBy }, now);
  if (result === "already") return { result };
  if (result === "added") return { result: "taken" };
  const asked = typeof input.askedBy === "string" && input.askedBy.trim() ? ` Asked by ${input.askedBy.trim()}.` : "";
  const rawText = `Mi Sheberach request for ${String(input.name).trim()}.${asked} Sent by ${actor.name ?? "a member of staff"}. This name once asked not to be listed, so it was not added.`;
  const [made] = await db.insert(proposals).values({ channel: "staff", submittedBy: null, submitterLabel: "Staff", rawText, reviewScope: "clergy" }).returning({ id: proposals.id });
  return { result: "taken", proposalId: made.id };
}
