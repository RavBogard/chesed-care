import { notFound } from "next/navigation";
import { Flyer } from "@/components/flyer/flyer";
import { noticeClass } from "@/components/ui";
import { AccessDenied } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { sheetFlyerUrl } from "@/server/volunteers/flyer";
import { getVolunteerSheet } from "@/server/volunteers/organiser";
import { appOriginOrNull } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Flyer · CRC Care" };

/** A page to print for a shiva sheet: the title, a plain invitation and the link. No dates beyond the sheet's own page, never a place. */
export default async function ShivaSheetFlyerPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const { id } = await params;
  let sheet;
  try {
    sheet = await getVolunteerSheet(getDb(), actor, id);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    if (error instanceof AccessDenied) return <p className={`${noticeClass} m-4`}>You do not have access to Volunteers.</p>;
    throw error;
  }
  // Without the app's address the flyer cannot carry a whole link.
  const origin = appOriginOrNull() ?? "";
  const heading = `Shiva for ${sheet.title}`;
  return (
    <Flyer
      backHref={`/volunteers/sheets/${id}`}
      backLabel="Back to the sheet"
      heading={heading}
      invitation="Please help make a minyan. Scan the code or visit the link to choose an evening."
      url={sheetFlyerUrl(sheet, origin)}
      qrLabel={`QR code for the ${heading} sheet`}
      noLinkMessage="This sheet has no link to print: it is cancelled or every evening has passed."
    />
  );
}
