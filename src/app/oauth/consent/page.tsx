import { PlainPage } from "@/components/plain-page";
import { btnPrimary, btnQuiet, cardClass, noticeClass } from "@/components/ui";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { authEnv } from "@/server/env";
import { describeConsentRequest } from "@/server/mcp/consent";
import { decideConnectionAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect Claude · CRC Care" };

/** The consent step of the Claude connector: shown to the signed-in person, who allows or denies. */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = actorOrRedirect(await getViewer());
  const request = await describeConsentRequest(getDb(), authEnv().secret, await searchParams);
  return (
    <PlainPage title="Connect Claude to CRC Care">
      {request ? (
        <>
          <div className={`${cardClass} [overflow-wrap:anywhere]`}>
            <p className="text-ink">
              You are signed in as <strong data-testid="consent-account">{actor.email}</strong>.
            </p>
            <p className="mt-2 text-ink">
              If you allow this, the app that calls itself <strong data-testid="consent-client">{request.clientName}</strong> will be able to read and add care records as you.
            </p>
            <p className="mt-2 text-sm text-rubric">
              You will return to <span data-testid="consent-destination" className="[overflow-wrap:anywhere]">{request.destination}</span>. Only allow this if you just asked Claude to connect.
            </p>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            <li>It can see what you can see here: dates, the care list, follow-ups and notes.</li>
            <li>It can log a contact, add someone to the care list and change follow-ups, as you.</li>
            <li>It cannot send texts, see giving, or change Salesforce.</li>
          </ul>
          <form action={decideConnectionAction} className="flex flex-wrap gap-3">
            <input type="hidden" name="oauth_query" value={request.oauthQuery} />
            <button type="submit" name="decision" value="allow" className={btnPrimary}>
              Allow
            </button>
            <button type="submit" name="decision" value="deny" className={btnQuiet}>
              Don&apos;t allow
            </button>
          </form>
        </>
      ) : (
        <p className={noticeClass} data-testid="consent-expired">
          This request has expired or is not valid. Go back to Claude and connect again.
        </p>
      )}
    </PlainPage>
  );
}
