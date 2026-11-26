import { notFound, redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { BriefUnavailable, BriefView } from "@/components/brief";
import { PrintButton } from "@/components/print-button";
import { AppShell } from "@/components/shell/app-shell";
import { canSeeLifecycle } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { type Brief, getBrief } from "@/server/care/brief";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { getSalesforce } from "@/server/salesforce";
import { logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brief · CRC Care" };

/** A one-page brief for clergy: computed from the person page and the lines on it, no model, and printable. */
export default async function BriefRoute({ params }: { params: Promise<{ contactId: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!canSeeLifecycle(actor)) redirect("/care");
  const { contactId } = await params;
  let brief: Brief | null = null;
  try {
    brief = await getBrief({ db: getDb(), sf: getSalesforce, now: new Date() }, actor, { contactId });
  } catch (error) {
    if (error instanceof NotFound) notFound();
    logFailure("Brief unavailable", error);
  }
  return (
    <AppShell actor={actor} title={brief?.name ? `Brief: ${brief.name}` : "Brief"}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <BackLink fallback={`/people/${contactId}`} />
        <PrintButton />
      </div>
      {brief ? <BriefView brief={brief} /> : <BriefUnavailable />}
    </AppShell>
  );
}
