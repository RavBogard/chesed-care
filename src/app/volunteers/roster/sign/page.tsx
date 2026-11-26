import { Flyer } from "@/components/flyer/flyer";
import { noticeClass } from "@/components/ui";
import { JOIN_NAME, JOIN_PATH, JOIN_SIGN_LINE } from "@/lib/roster-wording";
import { canManageRoster } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { appOriginOrNull } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign · CRC Care" };

/** A page to print: the congregation's name, one line, the QR code for the public sign-up and the link in words. Owner, clergy and the lead. */
export default async function RosterSignPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canManageRoster(actor)) return <p className={`${noticeClass} m-4`}>You do not have access to this page.</p>;
  // Without the app's address the sign cannot carry a whole link.
  const origin = appOriginOrNull();
  const url = origin ? `${origin}${JOIN_PATH}` : null;
  return <Flyer backHref="/volunteers/roster" backLabel="Back to the roster" heading={JOIN_NAME} invitation={JOIN_SIGN_LINE} url={url} qrLabel={`QR code for the page: ${JOIN_NAME}`} noLinkMessage="The app's address is not set, so there is no link to print." />;
}
