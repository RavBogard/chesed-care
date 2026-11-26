import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { VisitingCard } from "@/components/volunteers/visiting-card";
import { VISITING_EMPTY, VISITING_INTRO, VISITING_NAME } from "@/lib/visiting-wording";
import { canManageVisitingList, canSeeVisitingList } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { chicagoToday } from "@/server/lifecycle/window";
import { listVisiting, listVisitorChoices, type VisitingEntry, type VisitorChoice } from "@/server/volunteers/visiting";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Visiting list · CRC Care" };

/** The volunteer visiting list: owner, clergy and the lead. Anyone else is shown a page that does not exist. */
export default async function VisitingPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canSeeVisitingList(actor)) notFound();
  const db = getDb();
  const [entries, choices] = await soft<[VisitingEntry[] | null, VisitorChoice[]]>("Visiting list unavailable", [null, []], () => Promise.all([listVisiting(db, actor), listVisitorChoices(db, actor)]));
  const today = chicagoToday(new Date());
  const canManage = canManageVisitingList(actor);
  return (
    <AppShell actor={actor} title={VISITING_NAME}>
      <p className="mb-5 text-sm text-rubric">{VISITING_INTRO}</p>
      {entries === null ? <LoadNotice what="The visiting list" /> : null}
      {entries && entries.length === 0 ? <p className="text-rubric">{VISITING_EMPTY}</p> : null}
      {entries && entries.length > 0 ? (
        <ul className="divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="visiting-list">
          {entries.map((e) => (
            <VisitingCard key={e.id} entry={e} choices={choices} today={today} canManage={canManage} />
          ))}
        </ul>
      ) : null}
    </AppShell>
  );
}
