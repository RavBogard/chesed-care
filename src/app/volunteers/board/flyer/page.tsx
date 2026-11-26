import { Flyer } from "@/components/flyer/flyer";
import { CONGREGATION_NAME } from "@/lib/brand";
import { noticeClass } from "@/components/ui";
import { AccessDenied } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { boardFlyerUrl } from "@/server/volunteers/flyer";
import { findBoardLink } from "@/server/volunteers/organiser";
import { appOriginOrNull } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Flyer · CRC Care" };

/** A page to print for the poster's board link: one QR code to every open task. Nothing about any task. */
export default async function VolunteerBoardFlyerPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  let board: { token: string } | null;
  try {
    board = await findBoardLink(getDb(), actor);
  } catch (error) {
    if (error instanceof AccessDenied) return <p className={`${noticeClass} m-4`}>You do not have access to Volunteers.</p>;
    throw error;
  }
  // Without the app's address the flyer cannot carry a whole link.
  const origin = appOriginOrNull() ?? "";
  return (
    <Flyer
      backHref="/volunteers"
      backLabel="Back to Volunteers"
      heading="Ways to help"
      invitation={`${CONGREGATION_NAME} has some small requests. Scan the code or visit the link to see what could use a hand.`}
      url={boardFlyerUrl(board, origin)}
      qrLabel="QR code for the list of ways to help"
      noLinkMessage="You have no board link to print yet. Make one on the Volunteers page."
    />
  );
}
