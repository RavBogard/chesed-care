/**
 * The audit trail: who did what to which record, and when. `detail` is a closed
 * set of ids, enums and flags. It has no free-text field on purpose: note text,
 * summary text and a proposal's raw text can never be written here.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLog, careItems } from "@/server/db/schema";
import { chicagoToday } from "@/server/lifecycle/window";
import type { Db } from "@/server/db/types";
import type { Actor } from "@/server/access/policy";

export type AuditAction =
  | "restricted.view"
  | "care_item.restrict"
  | "care_item.reassign"
  | "care_item.staff_add"
  | "care_item.hand_over"
  | "user.change"
  | "contact.delete"
  | "follow_up.delete"
  | "follow_up.reassign"
  | "user.handover"
  | "proposal.accept"
  | "proposal.dismiss"
  | "proposal.release"
  | "proposal.practical_take"
  | "proposal.practical_keep"
  | "push_device.add"
  | "push_device.remove"
  | "capture_token.create"
  | "capture_token.revoke"
  | "meal_page.create"
  | "meal_page.go_live"
  | "meal_page.pause"
  | "meal_page.resume"
  | "meal_page.end"
  | "meal_page.family_change"
  | "meal_page.block_email"
  | "meal_page.update"
  | "meal_page.add_organiser"
  | "meal_page.remove_organiser"
  | "meal_page.withdraw_date"
  | "meal_signup.create"
  | "meal_signup.cancel"
  | "meal_signup.move"
  | "meal_signup.remove"
  | "follow_up.lead_done"
  | "journey.start"
  | "journey.end"
  | "journey_template.update"
  | "journey_template.reset"
  | "care_item.keep_notes"
  | "care_item.corps_note"
  | "care_item.notes_purged"
  | "volunteer_task.create"
  | "volunteer_task.update"
  | "volunteer_task.cancel"
  | "volunteer_task.done"
  | "volunteer_task.purge"
  | "volunteer_sheet.create"
  | "volunteer_claim.create"
  | "volunteer_claim.cancel"
  | "volunteer_claim.remove"
  | "volunteer_claim.done"
  | "volunteer_bringing.add"
  | "volunteer_bringing.remove"
  | "volunteer_board.create"
  | "volunteer_board.replace"
  | "volunteer_task.close_links"
  | "volunteer_series.create"
  | "volunteer_series.update"
  | "volunteer_series.cancel"
  | "volunteer_claim.every_time"
  | "corps_member.add"
  | "corps_member.update"
  | "corps_member.status"
  | "corps_member.ask"
  | "corps_member.stop_link"
  | "corps_member.join"
  | "corps_member.stop"
  | "visiting.add"
  | "visiting.update"
  | "visiting.end"
  | "visiting.visitor"
  | "visiting.visit"
  | "corps_referral.create"
  | "corps_referral.consent"
  | "corps_referral.take"
  | "corps_referral.close"
  | "mi_sheberach.add"
  | "mi_sheberach.update"
  | "mi_sheberach.end"
  | "mi_sheberach.renew"
  | "mi_sheberach.sync"
  | "mi_sheberach.import"
  | "mi_sheberach.apply_anyway"
  | "mi_sheberach.add_over_no"
  | "mi_sheberach.remove_barred"
  | "away.set"
  | "away.clear"
  | "agenda.add"
  | "agenda.discuss"
  | "agenda.carry"
  | "agenda.remove"
  | "agenda.purge"
  | "outside_person.update";

export type AuditSubject = "care_item" | "contact_log" | "follow_up" | "proposal" | "capture_token" | "push_device" | "user" | "meal_page" | "meal_signup" | "journey" | "journey_template" | "volunteer_task" | "volunteer_claim" | "volunteer_group" | "volunteer_board" | "volunteer_series" | "corps_member" | "visiting_entry" | "corps_referral" | "mi_sheberach_entry" | "mi_sheberach_sync" | "agenda_entry" | "outside_person";

export type AuditDetail = {
  careItemId?: string | null;
  ownerUserId?: string;
  previousOwnerUserId?: string;
  channel?: string;
  target?: "new" | "existing";
  restricted?: boolean;
  restrictedShowsCarer?: boolean;
  accessCount?: number;
  /** A team member's role or active flag, before and after (user.change). */
  role?: string;
  previousRole?: string;
  active?: boolean;
  previousActive?: boolean;
  /** The Chicago day of a restricted.view (one row per reader, item and day). */
  day?: string;
  mealPageId?: string;
  slotId?: string;
  /** The date a helper moved away from (meal_signup.move). */
  fromSlotId?: string;
  /** The colleague added to or removed from a meal page. */
  userId?: string;
  /** Who acted on a meal page: a signed-in organiser, or the family or a helper through their link. "system": the daily job. */
  by?: "organiser" | "family" | "helper" | "volunteer" | "system";
  /** A journey: its run and its template's key (one of four fixed keys), and how many steps it made or removed. */
  journeyId?: string;
  templateKey?: string;
  count?: number;
  /** The keep-notes flag after the change (care_item.keep_notes). */
  keepNotes?: boolean;
  /** Names of the meal page fields that changed; never their values. */
  fields?: MealAuditField[];
  /** A volunteer task, and its shiva sheet if it is on one (ids only). */
  volunteerTaskId?: string;
  volunteerGroupId?: string;
  /** A repeating series, a roster member (ids only; never a name or a contact). */
  volunteerSeriesId?: string;
  memberId?: string;
  /** A visiting list entry (id only; never a name, a place or a note). */
  visitingId?: string;
  /** A referral to Mitzvah Corps: its enum values only (never a name, a contact line or a note). `consent` below is shared. */
  referralKind?: string;
  closedAs?: string;
  /** Whether the removed helper's email was also blocked from the page. */
  blocked?: boolean;
  /** Mi Sheberach: the enum values of an entry (never its name or any text). */
  reason?: string;
  entryKind?: string;
  consent?: string;
  source?: string;
};

export type MealAuditField = "foodFor" | "kashrut" | "dietary" | "allergies" | "dropOffWindow" | "dropOffInstructions" | "dropOffAddress" | "dropOffIsHome" | "thanks";

export async function writeAudit(db: Db, actor: Actor, action: AuditAction, subjectType: AuditSubject, subjectId: string, detail?: AuditDetail): Promise<void> {
  await db.insert(auditLog).values({ actorUserId: actor.id, action, subjectType, subjectId, detail: detail ?? null });
}

/**
 * Record full reads of restricted items by someone other than their owner, on every
 * path that returns one (lists, boards, a person's page, a single item): at most one
 * row per reader, item and Chicago day.
 */
export async function auditRestrictedReads(db: Db, actor: Actor, items: { id: string; restricted: boolean; ownerUserId: string }[]): Promise<void> {
  const ids = [...new Set(items.filter((i) => i.restricted && i.ownerUserId !== actor.id).map((i) => i.id))];
  if (ids.length === 0) return;
  const day = chicagoToday(new Date());
  const seen = await db
    .select({ id: auditLog.subjectId })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, actor.id), eq(auditLog.action, "restricted.view"), inArray(auditLog.subjectId, ids), sql`${auditLog.detail}->>'day' = ${day}`));
  const done = new Set(seen.map((r) => r.id));
  const fresh = ids.filter((id) => !done.has(id));
  if (fresh.length === 0) return;
  await db.insert(auditLog).values(fresh.map((subjectId) => ({ actorUserId: actor.id, action: "restricted.view", subjectType: "care_item", subjectId, detail: { day } })));
}

/** Something done through a meal page's family link or a helper's link: there is no signed-in actor, so the row has none and says who by. */
export async function writeLinkAudit(db: Db, by: "family" | "helper" | "volunteer", action: AuditAction, subjectType: AuditSubject, subjectId: string, detail: AuditDetail = {}): Promise<void> {
  await db.insert(auditLog).values({ actorUserId: null, action, subjectType, subjectId, detail: { ...detail, by } });
}

/** Something the daily job did: no signed-in actor, ids only. */
export async function writeSystemAudit(db: Db, action: AuditAction, subjectType: AuditSubject, subjectId: string, detail: AuditDetail = {}): Promise<void> {
  await db.insert(auditLog).values({ actorUserId: null, action, subjectType, subjectId, detail: { ...detail, by: "system" } });
}

/**
 * The same record for a read that returns what hangs off a care item (its follow-ups,
 * its contact entries): of those item ids, the restricted ones are audited as full reads.
 */
export async function auditRestrictedReadsByItem(db: Db, actor: Actor, careItemIds: (string | null)[]): Promise<void> {
  const ids = [...new Set(careItemIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return;
  const items = await db.select({ id: careItems.id, restricted: careItems.restricted, ownerUserId: careItems.ownerUserId }).from(careItems).where(and(inArray(careItems.id, ids), eq(careItems.restricted, true)));
  await auditRestrictedReads(db, actor, items);
}
