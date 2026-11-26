import { notFound, redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { BriefUnavailable, BriefView } from "@/components/brief";
import { PrintButton } from "@/components/print-button";
import { AppShell } from "@/components/shell/app-shell";
import { canManageOutsidePeople } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { type Brief, getBrief } from "@/server/care/brief";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { getSalesforce } from "@/server/salesforce";
import { logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brief · CRC Care" };

/** The same brief for someone kept only in this app. */
export default async function OutsideBriefRoute({ params }: { params: Promise<{ outsideId: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!canManageOutsidePeople(actor)) redirect("/care");
  const { outsideId } = await params;
  let brief: Brief | null = null;
  try {
    brief = await getBrief({ db: getDb(), sf: getSalesforce, now: new Date() }, actor, { outsidePersonId: outsideId });
  } catch (error) {
    if (error instanceof NotFound) notFound();
    logFailure("Brief unavailable", error);
  }
  return (
    <AppShell actor={actor} title={brief?.name ? `Brief: ${brief.name}` : "Brief"}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <BackLink fallback={`/people/outside/${outsideId}`} />
        <PrintButton />
      </div>
      {brief ? <BriefView brief={brief} /> : <BriefUnavailable />}
    </AppShell>
  );
}
