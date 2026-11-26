/**
 * CRC Care access policy: the ONE place that decides who may use the app and who
 * may see or change each record. Every server data function takes the acting user
 * and asks this module; nothing else grants access.
 *
 * Rules (PRODUCT.md, "Who it is for", "Privacy" and "v2"):
 *  - Access is by allowlist. An email in OWNER_EMAILS is an owner. Anyone else must
 *    be an active row in `users`. The owner role comes only from OWNER_EMAILS: a
 *    `users` row that says owner but is not in OWNER_EMAILS acts as clergy.
 *  - Owners and clergy ("clergy level") see every care item, follow-up and contact
 *    log entry that is not restricted, and the lifecycle dates.
 *  - A RESTRICTED care item is fully visible only to its owner and to the clergy
 *    named on it (care_item_access), and only while they are clergy level. No role
 *    overrides this, the owner role included. Only its owner changes the restriction,
 *    the access list or who holds it. Other clergy level users get a stub
 *    (the person, that it is restricted, the owner's name) when the item says so,
 *    and otherwise nothing. Follow-ups and contact log entries attached to a
 *    restricted item exist only for those with full access.
 *  - A contact log note marked private is readable only by its author; everyone
 *    else who can see the entry sees only that a contact happened, when, and by whom.
 *  - Caregivers see only care items assigned to them (and marked visible to
 *    caregivers), only their own follow-ups, and only their own contact log
 *    entries on care items visible to caregivers (so notes they wrote about
 *    clergy-only people, e.g. while they were clergy, stay hidden from them).
 *    They never see clergy notes or the lifecycle dates.
 *  - Caregivers are never given clergy-only work: a care item or follow-up goes
 *    to a caregiver only when its care item is visible to caregivers.
 *  - staff, lead and senior_staff report a need (a proposal) and see that their own
 *    reports were picked up. They see no dates or care records, and are never
 *    assigned any. Staff and leads also run meal pages, with a name-only search.
 *  - Proposals (the Inbox): anyone may submit one. Clergy level review the shared
 *    Inbox; a clergy member's own capture is theirs alone until they release it.
 *  - Mitzvah Meals pages: owner, clergy, lead and staff (see "Mitzvah Meals" below).
 *  - Only owners manage the allowlist.
 *
 * Each list rule has a predicate (for one loaded row) and a SQL condition (for
 * queries); tests run both over the same rows so they cannot drift apart.
 */
import { and, eq, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PrefKind } from "@/lib/notice";
import { agendaEntries, careItemAccess, careItems, contactLog, followUps, mealPageOrganisers, mealPages, outsidePeople, proposals, volunteerTasks } from "@/server/db/schema";

export const ROLES = ["owner", "clergy", "caregiver", "staff", "lead", "senior_staff"] as const;
export type Role = (typeof ROLES)[number];
/** The roles an owner can give someone in Settings. Owner itself comes only from OWNER_EMAILS. */
export const ASSIGNABLE_ROLES = ["clergy", "caregiver", "staff", "lead", "senior_staff"] as const satisfies readonly Exclude<Role, "owner">[];
export type Actor = { readonly id: string; readonly email: string; readonly name: string | null; readonly role: Role };

export class AccessDenied extends Error {
  constructor() {
    super("Not permitted");
    this.name = "AccessDenied";
  }
}

export function deny(): never {
  throw new AccessDenied();
}

// ─── allowlist ───────────────────────────────────────────────────────────────────────

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** OWNER_EMAILS: comma-separated; blanks and anything without an "@" are ignored. */
export function parseOwnerEmails(raw: string | undefined | null): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)),
  );
}

export type AllowlistRow = { id: string; role: Role; active: boolean };
export type AccessDecision = { kind: "owner" } | { kind: "member"; userId: string; role: Exclude<Role, "owner"> } | { kind: "denied" };

/** Decide whether a verified sign-in email may use the app, and as what. */
export function decideAccess(email: string, ownerEmails: ReadonlySet<string>, row: AllowlistRow | null): AccessDecision {
  const e = normalizeEmail(email);
  if (!e) return { kind: "denied" };
  if (ownerEmails.has(e)) return { kind: "owner" };
  if (!row || !row.active) return { kind: "denied" };
  return { kind: "member", userId: row.id, role: row.role === "owner" ? "clergy" : row.role };
}

/**
 * What a role is, in the three terms every rule below is written in. The switch is
 * exhaustive: a new role does not compile until it is placed here.
 */
type Tier = "clergy" | "caregiver" | "reporter";
function tier(role: Role): Tier {
  switch (role) {
    case "owner":
    case "clergy":
      return "clergy";
    case "caregiver":
      return "caregiver";
    case "staff":
    case "lead":
    case "senior_staff":
      return "reporter";
  }
}

export function isClergyLevel(actor: Actor): boolean {
  return tier(actor.role) === "clergy";
}

function isCaregiver(actor: Actor): boolean {
  return tier(actor.role) === "caregiver";
}

/** Clergy level or a caregiver: someone who works with care records at all. */
export function isCareTeam(actor: Actor): boolean {
  return tier(actor.role) !== "reporter";
}

export function canManageUsers(actor: Actor): boolean {
  return actor.role === "owner";
}

// ─── lifecycle dates ─────────────────────────────────────────────────────────────────

export function canSeeLifecycle(actor: Actor): boolean {
  return isClergyLevel(actor);
}

export function canMarkOccasion(actor: Actor): boolean {
  return isClergyLevel(actor);
}

// ─── restricted care items ───────────────────────────────────────────────────────────

/** `named`: the acting user has a care_item_access row for the item (see namedOn). */
export type RestrictionRow = { ownerUserId: string; restricted: boolean; named: boolean };

/** Whether a restricted item is closed to the actor. Never true for an unrestricted item. */
export function isRestrictedFrom(actor: Actor, item: RestrictionRow): boolean {
  if (!item.restricted) return false;
  return !(isClergyLevel(actor) && (item.ownerUserId === actor.id || item.named));
}

/** SQL for `named`, for a query with care_items in scope. */
export function namedOn(actor: Actor): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${careItemAccess} where ${careItemAccess.careItemId} = ${careItems.id} and ${careItemAccess.userId} = ${actor.id})`;
}

/** SQL twin of !isRestrictedFrom, for a query with care_items in scope. */
function notRestrictedFrom(actor: Actor): SQL {
  if (!isClergyLevel(actor)) return sql`not ${careItems.restricted}`;
  return sql`(not ${careItems.restricted} or ${careItems.ownerUserId} = ${actor.id} or ${namedOn(actor)})`;
}

/** SQL: the care item a row points at (if any) is not restricted away from the actor. */
function careItemOpenTo(actor: Actor, careItemId: AnyColumn): SQL {
  return sql`(${careItemId} is null or exists (select 1 from ${careItems} where ${careItems.id} = ${careItemId} and ${notRestrictedFrom(actor)}))`;
}

// ─── care items ──────────────────────────────────────────────────────────────────────

export type CareItemAccessRow = RestrictionRow & { visibility: "clergy" | "caregivers"; restrictedShowsCarer: boolean };

/** Full sight of a care item: every field, its follow-ups and its contact log. */
export function canSeeCareItem(actor: Actor, item: CareItemAccessRow): boolean {
  if (isRestrictedFrom(actor, item)) return false;
  if (isClergyLevel(actor)) return true;
  return isCaregiver(actor) && item.ownerUserId === actor.id && item.visibility === "caregivers";
}

export function careItemVisibleWhere(actor: Actor): SQL {
  if (isClergyLevel(actor)) return notRestrictedFrom(actor);
  if (!isCaregiver(actor)) return sql`false`;
  return and(eq(careItems.ownerUserId, actor.id), eq(careItems.visibility, "caregivers"), sql`not ${careItems.restricted}`)!;
}

/**
 * The stub of a restricted item: the person, that it is restricted, and the owner's
 * name. For clergy level without full access, when the item shows its carer.
 */
export function canSeeCareItemStub(actor: Actor, item: CareItemAccessRow): boolean {
  return isClergyLevel(actor) && isRestrictedFrom(actor, item) && item.restrictedShowsCarer;
}

export function careItemStubWhere(actor: Actor): SQL {
  if (!isClergyLevel(actor)) return sql`false`;
  return sql`(${careItems.restricted} and ${careItems.restrictedShowsCarer} and ${careItems.ownerUserId} <> ${actor.id} and not ${namedOn(actor)})`;
}

/** Create, assign, re-categorise, change visibility, pause, close or reopen (an item the actor fully sees). */
export function canManageCareItems(actor: Actor): boolean {
  return isClergyLevel(actor);
}

/**
 * Whether the item is restricted, whether it shows its carer, who is named on it and
 * (once it is restricted) who holds it: its current owner alone decides. A named
 * colleague reads it and works on it but changes none of these.
 */
export function canChangeRestriction(actor: Actor, item: { ownerUserId: string }): boolean {
  return isClergyLevel(actor) && item.ownerUserId === actor.id;
}

/** The owner role sees how many restricted items each departed holder left: a count and the holder's name, nothing of the items. */
export function canSeeStrandedRestricted(actor: Actor): boolean {
  return actor.role === "owner";
}

/**
 * The owner role may hand on restricted items blind, and only those whose holder can
 * no longer hold one (deactivated, or no longer clergy level), so a departure does
 * not strand them. A colleague who is still clergy keeps theirs whatever the owner
 * role wants. This gives the owner role no sight of any item.
 */
export function canHandOverRestricted(actor: Actor, holder: { role: Role; active: boolean }): boolean {
  return canSeeStrandedRestricted(actor) && !canHoldRestricted(holder);
}

/**
 * Who may hold a care item or a follow-up. Clergy level: anything. A caregiver: only
 * work visible to caregivers. Reporters (staff, lead, senior_staff): nothing.
 */
export function isValidAssignment(assignee: { role: Role; active: boolean }, visibility: CareItemAccessRow["visibility"]): boolean {
  if (!assignee.active) return false;
  switch (tier(assignee.role)) {
    case "clergy":
      return true;
    case "caregiver":
      return visibility === "caregivers";
    case "reporter":
      return false;
  }
}

/** Who may be named on a restricted item, or own one: active clergy level only. */
export function canHoldRestricted(user: { role: Role; active: boolean }): boolean {
  return user.active && tier(user.role) === "clergy";
}

// ─── outside people ──────────────────────────────────────────────────────────────────

/** People not in Salesforce: clergy level create, search and open them. */
export function canManageOutsidePeople(actor: Actor): boolean {
  return isClergyLevel(actor);
}

/**
 * An outside person is hidden when every care item about them is restricted away
 * from the actor: otherwise their row would say who a hidden item is about. Whoever
 * added the person still sees the row they wrote.
 */
export function canSeeOutsidePerson(actor: Actor, person: { createdBy: string }, items: RestrictionRow[]): boolean {
  if (!isClergyLevel(actor)) return false;
  return person.createdBy === actor.id || items.length === 0 || items.some((item) => !isRestrictedFrom(actor, item));
}

export function outsidePersonVisibleWhere(actor: Actor): SQL {
  if (!isClergyLevel(actor)) return sql`false`;
  const theirItems = sql`select 1 from ${careItems} where ${careItems.outsidePersonId} = ${outsidePeople.id}`;
  return sql`(${outsidePeople.createdBy} = ${actor.id} or not exists (${theirItems}) or exists (${theirItems} and ${notRestrictedFrom(actor)}))`;
}

// ─── follow-ups ──────────────────────────────────────────────────────────────────────

/**
 * `careItem`: the restriction of the follow-up's care item, or null when it has none.
 * `forLead`: a Mitzvah Corps journey step (follow_ups.for_lead).
 */
export type FollowUpAccessRow = { ownerUserId: string | null; careItem: RestrictionRow | null; forLead?: boolean };

/**
 * A Mitzvah Corps lead sees one kind of follow-up only: a journey step marked for
 * Mitzvah Corps, assigned to them, on a care item that is not restricted. Of it
 * they get the person's name, the step, its date and its logistics (listLeadSteps),
 * never the care item itself, its category, notes, contact log or other steps.
 */
function isOwnLeadStep(actor: Actor, followUp: FollowUpAccessRow): boolean {
  return actor.role === "lead" && followUp.forLead === true && followUp.ownerUserId === actor.id && followUp.careItem !== null && !followUp.careItem.restricted;
}

export function canSeeFollowUp(actor: Actor, followUp: FollowUpAccessRow): boolean {
  if (followUp.careItem && isRestrictedFrom(actor, followUp.careItem)) return false;
  if (isClergyLevel(actor)) return true;
  if (isCaregiver(actor)) return followUp.ownerUserId === actor.id;
  return isOwnLeadStep(actor, followUp);
}

export function followUpVisibleWhere(actor: Actor): SQL {
  const open = careItemOpenTo(actor, followUps.careItemId);
  if (isClergyLevel(actor)) return open;
  if (isCaregiver(actor)) return and(eq(followUps.ownerUserId, actor.id), open)!;
  if (actor.role !== "lead") return sql`false`;
  // careItemOpenTo for anyone below clergy level means "the item is not restricted".
  return and(eq(followUps.ownerUserId, actor.id), eq(followUps.forLead, true), sql`${followUps.careItemId} is not null`, open)!;
}

/** A lead marks their own step done, with an optional one-line outcome the item's owner sees. Nothing else of it is theirs to change. */
export function canCompleteLeadStep(actor: Actor, followUp: FollowUpAccessRow): boolean {
  return isOwnLeadStep(actor, followUp) && canSeeFollowUp(actor, followUp);
}

/**
 * Who may hold a Mitzvah Corps step: an active lead, and never on a restricted item.
 * On a restricted item the step goes to the item's owner instead, so the item's
 * existence never reaches a lead.
 */
export function canHoldLeadStep(user: { role: Role; active: boolean }, item: { restricted: boolean }): boolean {
  return user.active && user.role === "lead" && !item.restricted;
}

/**
 * Clergy may create a follow-up for anyone on the team, about a care item or a person.
 * A caregiver may create one only for themselves, on a care item they can see.
 */
export function canCreateFollowUp(actor: Actor, input: { ownerUserId: string; careItem: CareItemAccessRow | null }): boolean {
  if (input.careItem && !canSeeCareItem(actor, input.careItem)) return false;
  if (isClergyLevel(actor)) return true;
  return isCaregiver(actor) && input.ownerUserId === actor.id && input.careItem !== null;
}

/** Change title, due date or done state. Clergy: any they can see. Caregiver: their own. A lead: none (see canCompleteLeadStep). */
export function canEditFollowUp(actor: Actor, followUp: FollowUpAccessRow): boolean {
  return isCareTeam(actor) && canSeeFollowUp(actor, followUp);
}

/** Move a follow-up to another owner. Clergy only (a caregiver cannot hand work to others). */
export function canReassignFollowUp(actor: Actor): boolean {
  return isClergyLevel(actor);
}

/** Delete: its creator, its owner, or clergy level; in every case only one the actor can see. */
export function canDeleteFollowUp(actor: Actor, followUp: FollowUpAccessRow & { createdBy: string }): boolean {
  if (!isCareTeam(actor) || !canSeeFollowUp(actor, followUp)) return false;
  return isClergyLevel(actor) || followUp.createdBy === actor.id || followUp.ownerUserId === actor.id;
}

// ─── contact log ─────────────────────────────────────────────────────────────────────

export type ContactLogAccessRow = { authorUserId: string; private: boolean };
/**
 * An entry with the visibility of its care item (null when it is about a person
 * directly) and that item's restriction (null likewise).
 */
export type ContactLogListRow = ContactLogAccessRow & { careItemVisibility: CareItemAccessRow["visibility"] | null; careItem: RestrictionRow | null };

/**
 * Whether the entry is listed at all (its kind, time and author). Clergy level: all
 * but those on an item restricted from them. A caregiver: their own entries, on care
 * items visible to caregivers.
 */
export function canSeeContactEntry(actor: Actor, entry: ContactLogListRow): boolean {
  if (entry.careItem && isRestrictedFrom(actor, entry.careItem)) return false;
  if (isClergyLevel(actor)) return true;
  return isCaregiver(actor) && entry.authorUserId === actor.id && entry.careItemVisibility === "caregivers";
}

export function contactEntryVisibleWhere(actor: Actor): SQL {
  const open = careItemOpenTo(actor, contactLog.careItemId);
  if (isClergyLevel(actor)) return open;
  if (!isCaregiver(actor)) return sql`false`;
  return and(
    eq(contactLog.authorUserId, actor.id),
    sql`exists (select 1 from ${careItems} where ${careItems.id} = ${contactLog.careItemId} and ${careItems.visibility} = 'caregivers')`,
    open,
  )!;
}

/** Whether the note text is shown. A private note: its author only. */
export function canReadNote(actor: Actor, entry: ContactLogAccessRow): boolean {
  if (!isCareTeam(actor)) return false;
  if (entry.authorUserId === actor.id) return true;
  if (entry.private) return false;
  return isClergyLevel(actor);
}

/** Strip the note from an entry the actor may list but not read. */
export function redactEntry<T extends ContactLogAccessRow & { note: string | null }>(actor: Actor, entry: T): T & { noteHidden: boolean } {
  if (canReadNote(actor, entry)) return { ...entry, noteHidden: false };
  return { ...entry, note: null, noteHidden: true };
}

/** Clergy may log a contact with anyone. A caregiver only against a care item they can see. */
export function canCreateContactEntry(actor: Actor, careItem: CareItemAccessRow | null): boolean {
  if (careItem && !canSeeCareItem(actor, careItem)) return false;
  if (isClergyLevel(actor)) return true;
  return isCaregiver(actor) && careItem !== null;
}

/** Only the author edits or deletes an entry, including its private flag. */
export function canEditContactEntry(actor: Actor, entry: ContactLogAccessRow): boolean {
  return isCareTeam(actor) && entry.authorUserId === actor.id;
}

// ─── proposals (the Inbox) ───────────────────────────────────────────────────────────

export type ReviewScope = "submitter" | "clergy";
export type ProposalAccessRow = { submittedBy: string | null; reviewScope: ReviewScope };

/** Every signed-in (so active, allowlisted) user may report a need. */
export function canCreateProposal(actor: Actor): boolean {
  return ROLES.includes(actor.role);
}

/**
 * Who reviews a new proposal. A clergy level capture stays with its submitter unless
 * they ask for the shared Inbox; everyone else's always goes to clergy.
 */
export function reviewScopeFor(actor: Actor, requested: ReviewScope | undefined): ReviewScope {
  return isClergyLevel(actor) ? (requested ?? "submitter") : "clergy";
}

/** See a proposal in the Inbox, accept it or dismiss it. */
export function canReviewProposal(actor: Actor, proposal: ProposalAccessRow): boolean {
  if (!isClergyLevel(actor)) return false;
  return proposal.reviewScope === "clergy" || proposal.submittedBy === actor.id;
}

export function proposalReviewWhere(actor: Actor): SQL {
  if (!isClergyLevel(actor)) return sql`false`;
  return or(eq(proposals.reviewScope, "clergy"), eq(proposals.submittedBy, actor.id))!;
}

// ─── adding directly: staff and Mitzvah Corps leads ─────────────────────────────────────
//
// Daniel, 2026-11-25: the office adds people regularly, so their additions do not wait in the Inbox. Staff and leads
// put a member straight onto a rabbi's care list and a name straight onto the Mi Sheberach list
// (src/server/care/staff-add.ts). It is write-only: they see neither list, before or after, and the answer they get
// is the same whatever the app already holds about the person, so it says nothing about who is in care. They do see
// which rabbi is away today (so a sensitive item is not sent where no one could open it): accepted for an office.

export function canAddDirectly(actor: { role: Role }): boolean {
  return actor.role === "staff" || actor.role === "lead";
}

// ─── practical requests: the Mitzvah Corps lead sees the sender's own words, and nothing else ──────
//
// A public-form request for practical help (a meal, a ride, soup) that the sender chose to send to Mitzvah Corps AND that
// the sensitive-word floor let through (proposals.lead_visible) is shown to the lead in a narrow view (src/server/care/practical.ts).
// The lead never gets canReviewProposal: no other proposal, no reading, no reporter columns.

/** The roles that may see practical requests: owner, clergy and the Mitzvah Corps lead. */
export function canSeePracticalRequests(actor: { role: Role }): boolean {
  return actor.role === "owner" || actor.role === "clergy" || actor.role === "lead";
}

/** Saying "I'll take this" on one: the same roles. */
export function canTakePracticalRequest(actor: { role: Role }): boolean {
  return canSeePracticalRequests(actor);
}

/** Pulling a request back to clergy only ("Keep this to clergy"): clergy level. */
export function canKeepToClergy(actor: { role: Role }): boolean {
  return actor.role === "owner" || actor.role === "clergy";
}

/**
 * The practical requests an actor may see in the volunteers home: pending, from the public form, practical, and visible to the lead.
 * The lead gets exactly this and nothing more; owner and clergy must also pass their existing proposal access.
 */
export function practicalRequestVisibleWhere(actor: Actor): SQL {
  const base = and(eq(proposals.practical, true), eq(proposals.leadVisible, true), eq(proposals.status, "pending"), eq(proposals.channel, "form"))!;
  if (actor.role === "lead") return base;
  if (actor.role === "owner" || actor.role === "clergy") return and(base, proposalReviewWhere(actor))!;
  return sql`false`;
}

/** Move one's own submitter-scope proposal to the shared Inbox. */
export function canReleaseProposal(actor: Actor, proposal: ProposalAccessRow): boolean {
  return isClergyLevel(actor) && proposal.submittedBy === actor.id && proposal.reviewScope === "submitter";
}

/** Make, see and revoke one's own capture tokens (the iPhone Shortcut). Whoever may report a need may; the token acts as that person, with that person's own scope rules. */
export function canUseCaptureTokens(actor: { role: Role }): boolean {
  return ROLES.includes(actor.role);
}

/** The printable sign for the public "Let the clergy know" form. */
export function canPrintTellSign(actor: Actor): boolean {
  return isClergyLevel(actor);
}

// ─── Mitzvah Meals ───────────────────────────────────────────────────────────────────
//
// A meal page is logistics, not care: who cooks which night. Owner, clergy, the
// Mitzvah Corps lead and front-office staff set pages up; caregivers and senior
// staff have no access. Staff see only pages they organise or co-organise. Owner,
// clergy and lead see every page, except one linked to a restricted care item:
// that is listed and readable only for its organisers and for those with full
// access to the care item. The link to a care item is shown only to those who can
// fully read the item, and nothing of the item is ever exposed through a page.
// The public and family links carry no actor and are not decided here: each is a
// secret token (src/server/meals/public.ts, family.ts).

/** Create and manage meal pages at all. */
export function canManageMealPages(actor: { role: Role }): boolean {
  switch (actor.role) {
    case "owner":
    case "clergy":
    case "lead":
    case "staff":
      return true;
    case "caregiver":
    case "senior_staff":
      return false;
  }
}

/** Who may be an organiser or co-organiser of a page. */
export function canOrganiseMealPages(user: { role: Role; active: boolean }): boolean {
  return user.active && canManageMealPages(user);
}

/** `coOrganiser`: the actor has a meal_page_organisers row. `careItem`: the restriction of the linked care item, or null. */
export type MealPageAccessRow = { organiserUserId: string; coOrganiser: boolean; careItem: RestrictionRow | null };

/** See and manage one page: every field, the helpers' details and both links. */
export function canSeeMealPage(actor: Actor, page: MealPageAccessRow): boolean {
  if (!canManageMealPages(actor)) return false;
  if (page.organiserUserId === actor.id || page.coOrganiser) return true;
  if (actor.role === "staff") return false;
  return !(page.careItem && isRestrictedFrom(actor, page.careItem));
}

/**
 * The family's private link is handed out narrowly: to the page's organisers and
 * co-organisers, and to clergy level who can see the page. A lead who sees every
 * page but does not organise this one is not given it. Never in a list.
 */
export function canSeeMealFamilyLink(actor: Actor, page: MealPageAccessRow): boolean {
  if (!canSeeMealPage(actor, page)) return false;
  return page.organiserUserId === actor.id || page.coOrganiser || isClergyLevel(actor);
}

/** SQL for `coOrganiser`, for a query with meal_pages in scope. */
export function coOrganiserOf(actor: Actor): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${mealPageOrganisers} where ${mealPageOrganisers.pageId} = ${mealPages.id} and ${mealPageOrganisers.userId} = ${actor.id})`;
}

/** SQL twin of canSeeMealPage, for a query with meal_pages in scope. */
export function mealPageVisibleWhere(actor: Actor): SQL {
  if (!canManageMealPages(actor)) return sql`false`;
  const organises = sql`(${mealPages.organiserUserId} = ${actor.id} or ${coOrganiserOf(actor)})`;
  if (actor.role === "staff") return organises;
  return sql`(${organises} or ${careItemOpenTo(actor, mealPages.careItemId)})`;
}

/**
 * Link a page to a care item, and see that link afterwards: only with full sight of
 * the item. So a page for a restricted item is created only by its owner or the
 * clergy named on it, and a lead or staff member never learns a page has one.
 */
export function canLinkMealPageToCareItem(actor: Actor, item: CareItemAccessRow): boolean {
  return canManageMealPages(actor) && canSeeCareItem(actor, item);
}

/** The name-only household search for choosing who a page is for. It reads no care record. */
export function canSearchHouseholdNames(actor: Actor): boolean {
  return canManageMealPages(actor);
}

/** The meals line on a person: status, covered through, open dates. Clergy level, for pages they can see. */
export function canSeeMealsLine(actor: Actor): boolean {
  return isClergyLevel(actor);
}

// ─── Volunteer tasks ─────────────────────────────────────────────────────────────────
//
// A volunteer task is a small ask a volunteer with no account takes through a link.
// Owner, clergy and the Mitzvah Corps lead post and run them; staff, caregivers and
// senior staff cannot. A task carries nothing from a care record. It may be linked to a
// care item, but only by someone with full sight of that item, and the link is shown
// only to those who can fully read the item. Owner, clergy and leads see every task,
// except one linked to a RESTRICTED care item: that is visible only to its creator and
// to those with full access to the item (no role overrides this, the owner included).
// The public links carry no actor and are not decided here (src/server/volunteers/public.ts).

/** Post, see and run volunteer tasks at all. */
export function canPostVolunteerTasks(actor: { role: Role }): boolean {
  switch (actor.role) {
    case "owner":
    case "clergy":
    case "lead":
      return true;
    case "caregiver":
    case "staff":
    case "senior_staff":
      return false;
  }
}

/** `careItem`: the restriction of the linked care item, or null when the task has none. */
export type VolunteerTaskAccessRow = { createdBy: string; careItem: RestrictionRow | null };

/** See and manage one task (or shiva sheet): its claims, contacts and links. */
export function canSeeVolunteerTask(actor: Actor, task: VolunteerTaskAccessRow): boolean {
  if (!canPostVolunteerTasks(actor)) return false;
  if (task.createdBy === actor.id) return true;
  return !(task.careItem && isRestrictedFrom(actor, task.careItem));
}

/** SQL twin of canSeeVolunteerTask, for a query with volunteer_tasks in scope. */
export function volunteerTaskVisibleWhere(actor: Actor): SQL {
  if (!canPostVolunteerTasks(actor)) return sql`false`;
  return sql`(${volunteerTasks.createdBy} = ${actor.id} or ${careItemOpenTo(actor, volunteerTasks.careItemId)})`;
}

/** Link a task to a care item: only with full sight of the item, so a restricted item's task is made only by someone with full access. */
export function canLinkVolunteerTaskToCareItem(actor: Actor, item: CareItemAccessRow): boolean {
  return canPostVolunteerTasks(actor) && canSeeCareItem(actor, item);
}

/** The link to a care item is shown only to those who fully read the item: never to a lead. */
export function canSeeVolunteerTaskCareLink(actor: Actor, item: CareItemAccessRow | null): boolean {
  return item !== null && canSeeCareItem(actor, item);
}

/** The board link (all one's open tasks on one page) and the "past helpers who said ask me again" list. */
export function canMakeVolunteerBoard(actor: { role: Role }): boolean {
  return canPostVolunteerTasks(actor);
}

/**
 * The Mitzvah Corps roster (names and contacts of volunteers): owner, clergy and the lead, the same people who
 * run volunteer tasks. Staff, caregivers and senior staff see none of it. It holds nothing from a care record.
 */
export function canManageRoster(actor: { role: Role }): boolean {
  return canPostVolunteerTasks(actor);
}

/**
 * Referrals to Mitzvah Corps. Clergy level (owner, clergy) refer a person and withdraw a referral; the lead also sees the
 * open ones that are ready for her and acts on them ("I'll take this", done, they said no). Nothing is copied into a referral from a
 * care record: it holds what the rabbi chose to write, and what to tell her is the rabbi's to decide. Everyone else gets nothing, not even that it exists.
 */
export function canReferToCorps(actor: { role: Role }): boolean {
  return actor.role === "owner" || actor.role === "clergy";
}
export function canSeeCorpsReferrals(actor: { role: Role }): boolean {
  return canReferToCorps(actor) || actor.role === "lead";
}
/** Who is told on their phone that a referral is waiting: the lead only. A rabbi made it, and another rabbi may be unable to see the person. */
export function getsReferralNotice(actor: { role: Role }): boolean {
  return actor.role === "lead";
}

/**
 * The standing volunteer visiting list. Clergy level (owner, clergy) decide who is on it; the lead also sees it, assigns a
 * regular visitor and logs visits. It carries no health information. Everyone else gets nothing, not even that it exists.
 */
export function canManageVisitingList(actor: { role: Role }): boolean {
  return actor.role === "owner" || actor.role === "clergy";
}
export function canSeeVisitingList(actor: { role: Role }): boolean {
  return canManageVisitingList(actor) || actor.role === "lead";
}
export function canAssignVisitor(actor: { role: Role }): boolean {
  return canSeeVisitingList(actor);
}
export function canLogVolunteerVisit(actor: { role: Role }): boolean {
  return canSeeVisitingList(actor);
}

/**
 * The "For Mitzvah Corps" line on a care item: clergy level who fully see the item, and NEVER on a restricted
 * one (no role, the owner included, may put text there that a lead could read). A lead reads it only on their own
 * step (listLeadSteps), never from the item.
 */
export function canSetCorpsNote(actor: Actor, item: CareItemAccessRow): boolean {
  return canManageCareItems(actor) && canSeeCareItem(actor, item) && !item.restricted;
}
// ─── journeys ────────────────────────────────────────────────────────────────────────
//
// A journey's steps are ordinary follow-ups: whoever may see and change a follow-up
// decides as above. Starting and ending one is managing the care item.

/** Start a journey on an item, or end one: clergy level who fully see the item. */
export function canStartJourney(actor: Actor, item: CareItemAccessRow): boolean {
  return canManageCareItems(actor) && canSeeCareItem(actor, item);
}

/** See and edit the templates (titles, offsets, steps). Owner and clergy. */
export function canEditJourneyTemplates(actor: Actor): boolean {
  return isClergyLevel(actor);
}

// ─── note retention ──────────────────────────────────────────────────────────────────

/** Mark a care item's notes "keep" (or not): clergy level who fully see it. */
export function canSetKeepNotes(actor: Actor, item: CareItemAccessRow): boolean {
  return canManageCareItems(actor) && canSeeCareItem(actor, item);
}

// ─── the daily job and the morning summary ───────────────────────────────────────────

/** The "Daily job" block in Settings: when it last ran and each task's state, counts only. */
export function canSeeJobRuns(actor: Actor): boolean {
  return actor.role === "owner";
}

/** Everyone signed in chooses how their own morning summary reaches them. */
export function canSetSummaryPref(actor: Actor): boolean {
  return ROLES.includes(actor.role);
}

/** Whose morning summary counts the Inbox: those who review it. */
export function summaryCountsInbox(actor: Actor): boolean {
  return isClergyLevel(actor);
}

// ─── the Mi Sheberach list ───────────────────────────────────────────────────────────
//
// Owner and clergy manage the list; staff, leads, caregivers and senior staff neither see nor
// change it. Staff and leads may ADD a name (canAddDirectly), not yet confirmed, and see nothing of the list. An entry's NAME is read aloud in the synagogue, so it is not private and shows to
// every manager, even when the person is linked to a RESTRICTED care item. What is private is
// the link: it (and anything about the care item) is shown only to those who fully see the item,
// and no role overrides that, the owner included. The list never carries category, notes or why.

/** See, add, change, end and print the list, and run the packet sync. */
export function canManageMiSheberach(actor: { role: Role }): boolean {
  switch (actor.role) {
    case "owner":
    case "clergy":
      return true;
    case "caregiver":
    case "staff":
    case "lead":
    case "senior_staff":
      return false;
  }
}

/** The link from an entry to its care item: only for those who fully read that item. */
export function canSeeMiSheberachCareLink(actor: Actor, item: CareItemAccessRow | null): boolean {
  return canManageMiSheberach(actor) && item !== null && canSeeCareItem(actor, item);
}

/** Link an entry to a care item, or add the person from one: only with full sight of the item. */
export function canLinkMiSheberachToCareItem(actor: Actor, item: CareItemAccessRow): boolean {
  return canManageMiSheberach(actor) && canSeeCareItem(actor, item);
}

/** The packet's connection state and last sync run, counts only (Settings). */
export function canSeeMiSheberachSync(actor: Actor): boolean {
  return actor.role === "owner";
}

// ─── the team view, reports, suggestions and hand-over ───────────────────────────────
//
// The team view shows, for each person on the care team, how much work they hold. The
// restricted rule: the viewer's own row counts what they fully see; every other row counts
// NON-restricted work only, and each clergy row carries the same neutral line whether or not
// that person holds a restricted item, so no number, row or timing singles one out. The lists
// of work that needs someone are narrowed the same way (and by the ordinary visibility rules).

/** The team view: owner and clergy. */
export function canSeeTeamView(actor: Actor): boolean {
  return isClergyLevel(actor);
}

/** Hand a person's work over before they go: the owner role, which also deactivates people. */
export function canHandOverWork(actor: Actor): boolean {
  return canManageUsers(actor);
}

/** Reports: clergy level in full; senior staff the same page without names. */
export function canSeeReports(actor: Actor): boolean {
  return isClergyLevel(actor) || actor.role === "senior_staff";
}

/** Senior staff get the no-names, small-number version of the reports. */
export function reportsAreNameless(actor: Actor): boolean {
  return actor.role === "senior_staff";
}

/** In the nameless reports any count below this is shown as "fewer than 5". */
export const SMALL_NUMBER = 5;

/** "You might reach out to": clergy level, for what they already fully see. */
export function canSeeOutreachSuggestions(actor: Actor): boolean {
  return isClergyLevel(actor);
}

/** The viewer's own restricted work is counted for them; everyone else's counts non-restricted work only. SQL for care_items. */
export function teamItemWhere(actor: Actor): SQL {
  return and(careItemVisibleWhere(actor), sql`(not ${careItems.restricted} or ${careItems.ownerUserId} = ${actor.id})`)!;
}

/** SQL for follow_ups: visible to the actor, and on a restricted item only when it is the actor's own. */
export function teamFollowUpWhere(actor: Actor): SQL {
  const plain = sql`(${followUps.careItemId} is null or exists (select 1 from ${careItems} where ${careItems.id} = ${followUps.careItemId} and not ${careItems.restricted}))`;
  return and(followUpVisibleWhere(actor), or(eq(followUps.ownerUserId, actor.id), plain))!;
}

/** SQL for contact_log: listed for the actor, and on a restricted item only when the actor wrote it. */
export function teamContactWhere(actor: Actor): SQL {
  const plain = sql`(${contactLog.careItemId} is null or exists (select 1 from ${careItems} where ${careItems.id} = ${contactLog.careItemId} and not ${careItems.restricted}))`;
  return and(contactEntryVisibleWhere(actor), or(eq(contactLog.authorUserId, actor.id), plain))!;
}

// ─── phone notifications ─────────────────────────────────────────────────────────────
//
// A notification is a fixed sentence, a count and a link (src/lib/notice.ts): it never names a person or
// quotes a note, so the words themselves reveal nothing. Even so, a person is only ever notified about an
// item they could open: the callers in src/server/notify decide each audience with the rules below and the
// item rules above (proposalReviewWhere, careItemVisibleWhere, followUpVisibleWhere, volunteerTaskVisibleWhere,
// mealPageVisibleWhere), never with a role list of their own.

/** Everyone who can sign in may turn notifications on for their own devices. */
export function canSetNotifications(actor: { role: Role }): boolean {
  return ROLES.includes(actor.role);
}

/** The switches a role is shown in Settings: the kinds that could ever reach it. */
export function noticeKindsFor(actor: { role: Role }): readonly PrefKind[] {
  const kinds: PrefKind[] = [];
  if (tier(actor.role) === "clergy") kinds.push("urgent_inbox", "new_inbox");
  if (tier(actor.role) !== "reporter" || actor.role === "lead") kinds.push("assigned");
  // The practical-request notice shares the coordinator switch: lead (default on), owner and clergy (default off).
  if (canPostVolunteerTasks(actor) || canManageMealPages(actor)) kinds.push("coordinator");
  return kinds;
}

/** Whether a kind is on for a person who has not chosen: urgent for clergy and owner, assigned for all, coordinator for leads. */
export function noticeDefaultOn(role: Role, kind: PrefKind): boolean {
  switch (kind) {
    case "urgent_inbox":
      return role === "owner" || role === "clergy";
    case "new_inbox":
      return false;
    case "assigned":
      return true;
    case "coordinator":
      return role === "lead";
  }
}

/** Whether a person is ever sent this kind (it must be one of theirs, switched on by their choice or their default). */
export function wantsNotice(actor: { role: Role }, kind: PrefKind, chosen: Partial<Record<PrefKind, boolean>>): boolean {
  if (!noticeKindsFor(actor).includes(kind)) return false;
  return chosen[kind] ?? noticeDefaultOn(actor.role, kind);
}

// ─── clergy tools: the agenda, away and cover, search in notes, hospital visits ──────
//
// All four are for clergy level. The one rule that matters: whatever hangs off a RESTRICTED care item exists
// only for those who fully see that item (no role overrides, the owner included), and that is decided in SQL
// by the predicates already above (careItemOpenTo and friends), never by filtering rows afterwards.

/** The clergy meeting agenda, the "In hospital now" list, and search in notes: owner and clergy. */
export function canUseAgenda(actor: Actor): boolean {
  return isClergyLevel(actor);
}

export function canSearchNotes(actor: Actor): boolean {
  return isClergyLevel(actor);
}

export function canSeeVisits(actor: Actor): boolean {
  return isClergyLevel(actor);
}

/** Put a care item on the agenda: clergy level who fully see it. */
export function canAddAgendaForItem(actor: Actor, item: CareItemAccessRow): boolean {
  return canUseAgenda(actor) && canSeeCareItem(actor, item);
}

/**
 * SQL for agenda_entries: clergy level only, and an entry linked to a care item only when the viewer fully sees that
 * item. An entry about an outside person alone follows that person's own visibility. To everyone else it does not exist.
 */
export function agendaEntryVisibleWhere(actor: Actor): SQL {
  if (!canUseAgenda(actor)) return sql`false`;
  const person = sql`(${agendaEntries.outsidePersonId} is null or exists (select 1 from ${outsidePeople} where ${outsidePeople.id} = ${agendaEntries.outsidePersonId} and ${outsidePersonVisibleWhere(actor)}))`;
  return and(careItemOpenTo(actor, agendaEntries.careItemId), person)!;
}

/** SQL for contact_log: the note text may be matched or shown to this viewer (a private note: its author only). */
export function contactNoteReadableWhere(actor: Actor): SQL {
  if (!isCareTeam(actor)) return sql`false`;
  if (isClergyLevel(actor)) return sql`(${contactLog.authorUserId} = ${actor.id} or not ${contactLog.private})`;
  return eq(contactLog.authorUserId, actor.id);
}

/** Set "I'm away" for oneself (clergy level), or for a colleague (the owner). */
export function canSetAway(actor: Actor, userId: string): boolean {
  return isClergyLevel(actor) && (actor.id === userId || actor.role === "owner");
}

/** Whether a person may be named as the one covering: an active clergy level user. */
export function canCover(user: { role: Role; active: boolean }): boolean {
  return user.active && (user.role === "owner" || user.role === "clergy");
}

/** Edit an outside person: those who may manage outside people (and so see this one). */
export function canEditOutsidePerson(actor: Actor): boolean {
  return canManageOutsidePeople(actor);
}

/** "Told to us by": clergy level. Which items it shows on is decided in SQL by careItemVisibleWhere (src/server/care/reporter.ts). */
export function canSeeReporterLine(actor: Actor): boolean {
  return isClergyLevel(actor);
}
