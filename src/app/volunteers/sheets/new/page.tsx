import { AppShell } from "@/components/shell/app-shell";
import { noticeClass } from "@/components/ui";
import { SheetForm } from "@/components/volunteers/sheet-form";
import { canLinkVolunteerTaskToCareItem, canPostVolunteerTasks } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { loadVisibleCareItemAccess } from "@/server/care/care-items";
import { getDb } from "@/server/db/client";
import { chicagoToday } from "@/server/lifecycle/window";

export const dynamic = "force-dynamic";
export const metadata = { title: "Post a shiva sheet · CRC Care" };

export default async function NewShivaSheetPage({ searchParams }: { searchParams: Promise<{ careItem?: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canPostVolunteerTasks(actor)) {
    return (
      <AppShell actor={actor} title="Post a shiva sheet">
        <p className={noticeClass}>You do not have access to post volunteer tasks.</p>
      </AppShell>
    );
  }
  const { careItem } = await searchParams;
  let careItemId: string | undefined;
  let problem = false;
  if (careItem) {
    try {
      const { item, access } = await loadVisibleCareItemAccess(getDb(), actor, careItem);
      if (!canLinkVolunteerTaskToCareItem(actor, access)) throw new Error("hidden");
      careItemId = item.id;
    } catch {
      problem = true;
    }
  }
  return (
    <AppShell actor={actor} title="Post a shiva sheet">
      {problem ? <p className={`${noticeClass} mb-5`}>That care item could not be found, so the sheet will not be linked to one.</p> : null}
      <SheetForm today={chicagoToday(new Date())} careItemId={careItemId} />
    </AppShell>
  );
}
