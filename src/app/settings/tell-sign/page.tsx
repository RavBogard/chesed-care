import { Flyer } from "@/components/flyer/flyer";
import { noticeClass } from "@/components/ui";
import { TELL_NAME, TELL_PATH, TELL_SIGN_LINE } from "@/lib/tell-wording";
import { canPrintTellSign } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { appOriginOrNull } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign · CRC Care" };

/** A page to print: the congregation's name, one line, the QR code for the public form, and the link in words. Clergy and the owner only. */
export default async function TellSignPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canPrintTellSign(actor)) return <p className={`${noticeClass} m-4`}>You do not have access to this page.</p>;
  // Without the app's address the sign cannot carry a whole link.
  const origin = appOriginOrNull();
  const url = origin ? `${origin}${TELL_PATH}` : null;
  return <Flyer backHref="/settings/admin" backLabel="Back to Admin" heading={TELL_NAME} invitation={TELL_SIGN_LINE} url={url} qrLabel={`QR code for the page: ${TELL_NAME}`} noLinkMessage="The app's address is not set, so there is no link to print." urlTestId="tell-sign-url" />;
}
