/**
 * Handing a person's work over before they leave (the owner role, in Settings).
 * Open items and follow-ups that are NOT restricted go to chosen people, in bulk or one
 * by one, through the ordinary reassign paths (updateCareItem, updateFollowUp) and so
 * under the same policy. Restricted items are never read or counted here: after the
 * person is deactivated they go through handOverRestrictedItems, unchanged. Each move
 * is audited by id only.
 */
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { canHandOverWork, deny, normalizeEmail, type Actor, type Role } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { updateCareItem } from "@/server/care/care-items";
import { reassignFollowUp } from "./reassign";
import { InvalidInput, NotFound, uuidField, uuidOrNotFound } from "@/server/care/validate";
import { careItems, followUps, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

export type HeldCounts = { userId: string; items: number; followUps: number };

const notRestrictedItem = sql`(${followUps.careItemId} is null or exists (select 1 from ${careItems} where ${careItems.id} = ${followUps.careItemId} and not ${careItems.restricted}))`;

/** How much non-restricted work each person holds (for the Deactivate button: a sheet only when there is some). Owner role only. */
export async function heldCounts(db: Db, actor: Actor): Promise<Map<string, HeldCounts>> {
  if (!canHandOverWork(actor)) deny();
  const [items, fus] = await Promise.all([
    db.select({ id: careItems.ownerUserId, n: count() }).from(careItems).where(and(ne(careItems.status, "closed"), eq(careItems.restricted, false))).groupBy(careItems.ownerUserId),
    db.select({ id: followUps.ownerUserId, n: count() }).from(followUps).where(and(isNull(followUps.doneAt), notRestrictedItem)).groupBy(followUps.ownerUserId),
  ]);
  const out = new Map<string, HeldCounts>();
  const at = (id: string) => out.get(id) ?? out.set(id, { userId: id, items: 0, followUps: 0 }).get(id)!;
  for (const r of items) at(r.id).items = r.n;
  for (const r of fus) if (r.id) at(r.id).followUps = r.n;
  return out;
}

export type HeldItem = { id: string; name: string; category: string };
export type HeldFollowUp = { id: string; name: string; title: string; due: string; leadStep: boolean };
export type HeldWork = { userId: string; role: Role; name: string; items: HeldItem[]; followUps: HeldFollowUp[] };

async function loadHeld(db: Db, userId: string): Promise<HeldWork> {
  const [user] = await db.select({ id: users.id, role: users.role, name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFound();
  const [items, fus] = await Promise.all([
    db
      .select({ id: careItems.id, name: careItems.displayName, category: careItems.category })
      .from(careItems)
      .where(and(eq(careItems.ownerUserId, userId), ne(careItems.status, "closed"), eq(careItems.restricted, false)))
      .orderBy(careItems.displayName),
    db
      .select({ id: followUps.id, name: followUps.displayName, title: followUps.title, due: followUps.dueDate, forLead: followUps.forLead })
      .from(followUps)
      .where(and(eq(followUps.ownerUserId, userId), isNull(followUps.doneAt), notRestrictedItem))
      .orderBy(followUps.dueDate),
  ]);
  return {
    userId,
    role: user.role,
    name: user.name ?? user.email,
    items,
    followUps: fus.map((f) => ({ id: f.id, name: f.name ?? "Name not recorded", title: f.title, due: f.due, leadStep: f.forLead && user.role === "lead" })),
  };
}

/** What would be handed over, for the sheet. Restricted items are not read, not counted and not hinted at. */
export async function getHeldWork(db: Db, actor: Actor, userId: unknown): Promise<HeldWork> {
  if (!canHandOverWork(actor)) deny();
  return loadHeld(db, uuidOrNotFound(userId));
}

export type HandoverPlan = {
  /** Everything not listed in the overrides goes to this person. */
  itemsTo?: unknown;
  followUpsTo?: unknown;
  /** A lead's Mitzvah Corps steps: another lead's user id, or "owners" for each step's care item owner. */
  leadStepsTo?: unknown;
  itemOverrides?: Record<string, unknown>;
  followUpOverrides?: Record<string, unknown>;
};

/**
 * Move everything the person holds (see HeldWork) to the chosen people, all or nothing:
 * the plan must name someone for every item and follow-up, and when it is done nothing
 * non-restricted is left with them. Their restricted items are untouched.
 */
export async function handOverWork(db: Db, actor: Actor, fromUserId: unknown, plan: HandoverPlan, ownerEmails: ReadonlySet<string>, moved?: (toUserId: string, what: { careItemId?: string; followUpId?: string }) => void): Promise<{ items: number; followUps: number }> {
  if (!canHandOverWork(actor)) deny();
  const from = uuidField(fromUserId, "fromUserId");
  if (from === actor.id) throw new InvalidInput("fromUserId");
  // Someone on the owner allowlist cannot be deactivated, so their work is never moved.
  const [leaving] = await db.select({ email: users.email }).from(users).where(eq(users.id, from)).limit(1);
  if (!leaving) throw new NotFound();
  if (ownerEmails.has(normalizeEmail(leaving.email))) throw new InvalidInput("fromUserId");
  const pick = (override: unknown, bulk: unknown, field: string): string => {
    const to = uuidField(override ?? bulk, field);
    if (to === from) throw new InvalidInput(field);
    return to;
  };
  return db.transaction(async (tx) => {
    const held = await loadHeld(tx, from);
    for (const item of held.items) {
      const to = pick(plan.itemOverrides?.[item.id], plan.itemsTo, "itemsTo");
      await updateCareItem(tx, actor, item.id, { ownerUserId: to });
      moved?.(to, { careItemId: item.id });
    }
    // Items have new owners now: "owners" means those.
    const itemOwner = new Map<string, string>();
    const links = held.followUps.length
      ? await tx.select({ id: followUps.id, careItemId: followUps.careItemId, owner: careItems.ownerUserId }).from(followUps).leftJoin(careItems, eq(careItems.id, followUps.careItemId)).where(inArray(followUps.id, held.followUps.map((f) => f.id)))
      : [];
    for (const l of links) if (l.owner) itemOwner.set(l.id, l.owner);
    for (const f of held.followUps) {
      let to: string;
      const override = plan.followUpOverrides?.[f.id];
      if (f.leadStep && override === undefined && plan.leadStepsTo === "owners") {
        const owner = itemOwner.get(f.id);
        if (!owner) throw new InvalidInput("leadStepsTo");
        to = owner;
      } else {
        to = pick(override, f.leadStep ? plan.leadStepsTo : plan.followUpsTo, f.leadStep ? "leadStepsTo" : "followUpsTo");
      }
      await reassignFollowUp(tx, actor, f.id, to);
      moved?.(to, { followUpId: f.id });
    }
    const left = await loadHeld(tx, from);
    if (left.items.length > 0 || left.followUps.length > 0) throw new InvalidInput("work");
    await writeAudit(tx, actor, "user.handover", "user", from, { count: held.items.length + held.followUps.length });
    return { items: held.items.length, followUps: held.followUps.length };
  });
}
