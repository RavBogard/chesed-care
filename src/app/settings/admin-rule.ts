import { canEditJourneyTemplates, canManageUsers, canPrintTellSign, canReleaseImportedEmails, canSeeJobRuns, canSeeMiSheberachSync, type Actor } from "@/server/access/policy";

export const ADMIN_TITLE = "Admin";

/**
 * Whether the Admin page has anything for this person. It grants nothing: every section on the page keeps its own
 * rule, and this is only "at least one of them is yours", so the page and its links are not shown to someone who
 * would find it empty.
 */
export function hasAdmin(actor: Actor): boolean {
  return canManageUsers(actor) || canEditJourneyTemplates(actor) || canSeeJobRuns(actor) || canSeeMiSheberachSync(actor) || canPrintTellSign(actor) || canReleaseImportedEmails(actor);
}
