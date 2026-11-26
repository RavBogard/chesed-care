import { AddEntryForm } from "@/components/misheberach/entry-forms";
import { AppShell } from "@/components/shell/app-shell";
import { noticeClass } from "@/components/ui";
import { canLinkMiSheberachToCareItem, canManageMiSheberach } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { loadVisibleCareItemAccess } from "@/server/care/care-items";
import { getDb } from "@/server/db/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Add a name · CRC Care" };

type Params = { careItem?: string; name?: string; contact?: string; outside?: string };

/** Add a name. Arriving from a care item (or the illness journey's step) prefills the person and links the care item, but only for someone who fully sees that item. */
export default async function NewMiSheberachPage({ searchParams }: { searchParams: Promise<Params> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canManageMiSheberach(actor)) {
    return (
      <AppShell actor={actor} title="Add a name">
        <p className={noticeClass}>The Mi Sheberach list is kept by the clergy.</p>
      </AppShell>
    );
  }
  const q = await searchParams;
  let careItemId: string | undefined;
  let preset: { name: string; contactId?: string; outsidePersonId?: string } | undefined = q.name || q.contact || q.outside ? { name: (q.name ?? "").slice(0, 200), ...(q.contact ? { contactId: q.contact } : {}), ...(q.outside ? { outsidePersonId: q.outside } : {}) } : undefined;
  let problem = false;
  if (q.careItem) {
    try {
      const { item, access } = await loadVisibleCareItemAccess(getDb(), actor, q.careItem);
      if (!canLinkMiSheberachToCareItem(actor, access)) throw new Error("hidden");
      careItemId = item.id;
      preset = { name: item.displayName ?? preset?.name ?? "", ...(item.sfContactId ? { contactId: item.sfContactId } : {}), ...(item.outsidePersonId ? { outsidePersonId: item.outsidePersonId } : {}) };
    } catch {
      problem = true;
    }
  }
  return (
    <AppShell actor={actor} title="Add a name">
      {problem ? <p className={`${noticeClass} mb-5`}>That care item could not be found, or you cannot link it. You can still add the name.</p> : null}
      <p className="mb-5 text-base text-rubric">The name goes on the list at once, marked not yet confirmed, so a member of the clergy can check with the person.</p>
      <AddEntryForm careItemId={careItemId} preset={preset} />
    </AppShell>
  );
}
