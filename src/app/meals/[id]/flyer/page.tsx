import { notFound } from "next/navigation";
import { Flyer } from "@/components/flyer/flyer";
import { noticeClass } from "@/components/ui";
import { heading } from "@/lib/meals-wording";
import { AccessDenied } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { getMealPageForOrganiser } from "@/server/meals/pages";
import { appOriginOrNull } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Flyer · CRC Care" };

/**
 * A page to print: the family's name, a plain invitation, a QR code and the link in
 * words. No dates, address or reason. On screen it has a Print button; on paper only the
 * flyer.
 */
export default async function FlyerPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const { id } = await params;
  let title: string;
  let url: string | null = null;
  try {
    const page = await getMealPageForOrganiser(getDb(), actor, id);
    title = page.title;
    // Without the app's address the flyer cannot carry a whole link.
    const origin = appOriginOrNull() ?? "";
    url = page.publicToken && (page.status === "live" || page.status === "paused") && origin ? `${origin}/m/${page.publicToken}` : null;
  } catch (error) {
    if (error instanceof NotFound) notFound();
    if (error instanceof AccessDenied) return <p className={`${noticeClass} m-4`}>You do not have access to this page.</p>;
    throw error;
  }
  return (
    <Flyer
      backHref={`/meals/${id}`}
      backLabel="Back to the page"
      heading={heading(title)}
      invitation="Please help with a meal. Scan the code or visit the link to choose a night."
      url={url}
      qrLabel={`QR code for the Mitzvah Meals page for ${title}`}
      noLinkMessage="This page has no link to print: it has ended or its links have been removed."
    />
  );
}
