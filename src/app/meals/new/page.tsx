import { NewMealsForm, type Preset } from "@/components/meals/new-form";
import { AppShell } from "@/components/shell/app-shell";
import { noticeClass } from "@/components/ui";
import { canLinkMealPageToCareItem, canManageMealPages } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { loadVisibleCareItemAccess } from "@/server/care/care-items";
import { getOutsidePerson } from "@/server/care/outside-people";
import { getDb } from "@/server/db/client";
import { resolveHouseholdName } from "@/server/lifecycle/household-names";
import { chicagoToday } from "@/server/lifecycle/window";
import { gridData } from "@/server/meals/grid-data";
import { getSalesforce } from "@/server/salesforce";

export const dynamic = "force-dynamic";
export const metadata = { title: "Start a page · CRC Care" };

type Params = { careItem?: string; outside?: string; contact?: string };

/** The person the page is for, when the link says (from a care item, an outside person or a person's page). Null: the organiser searches. */
async function presetFrom(actor: Parameters<typeof canLinkMealPageToCareItem>[0], q: Params): Promise<Preset> {
  const db = getDb();
  if (q.careItem) {
    const { item, access } = await loadVisibleCareItemAccess(db, actor, q.careItem);
    if (!canLinkMealPageToCareItem(actor, access)) throw new Error("hidden");
    return { field: "careItemId", id: item.id, name: item.displayName ?? "" };
  }
  if (q.outside) {
    const p = await getOutsidePerson(db, actor, q.outside);
    return { field: "outsidePersonId", id: p.id, name: p.name };
  }
  if (q.contact) {
    const who = await resolveHouseholdName({ sf: getSalesforce }, actor, q.contact);
    return { field: "contactId", id: who.contactId, name: who.name };
  }
  return null;
}

/** Set up a page asking only for the household, the nights and the family's yes. */
export default async function NewMealsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canManageMealPages(actor)) {
    return (
      <AppShell actor={actor} title="Start a page">
        <p className={noticeClass}>You do not have access to start a Mitzvah Meals page.</p>
      </AppShell>
    );
  }
  let preset: Preset = null;
  let problem = false;
  try {
    preset = await presetFrom(actor, await searchParams);
  } catch {
    problem = true;
  }
  const today = chicagoToday(new Date());
  const grid = gridData(today);
  return (
    <AppShell actor={actor} title="Start a page">
      {problem ? <p className={`${noticeClass} mb-5`}>That person could not be found, or you cannot start a page for them. Search for the household below.</p> : null}
      <NewMealsForm preset={preset} today={today} months={grid.months} notes={grid.notes} suggested={grid.suggested} />
    </AppShell>
  );
}
