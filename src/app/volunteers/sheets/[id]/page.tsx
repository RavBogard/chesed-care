import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelSheetAction, removeBringingAction } from "@/app/volunteers-actions";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet, noticeClass, tagQuiet } from "@/components/ui";
import { ClaimList } from "@/components/volunteers/claim-list";
import { whenWords } from "@/components/volunteers/parts";
import { AskRosterSection, loadAskRows } from "@/components/roster/ask-section";
import { ShareKit } from "@/components/volunteers/share-kit";
import { towardTen } from "@/lib/volunteers-wording";
import { AccessDenied } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { getVolunteerSheet, type SheetView } from "@/server/volunteers/organiser";
import { LoadNotice } from "@/components/load-notice";
import { appOriginOrNull, logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shiva sheet · CRC Care" };

const origin = () => appOriginOrNull() ?? "";

/** A shiva sheet for the poster: the one link, each evening's count toward ten with who signed up, and the "bringing" list with a remove on every line. */
export default async function ShivaSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const { id } = await params;
  let sheet: SheetView;
  try {
    sheet = await getVolunteerSheet(getDb(), actor, id);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    if (error instanceof AccessDenied) {
      return (
        <AppShell actor={actor} title="Shiva sheet">
          <p className={noticeClass}>You do not have access to Volunteers.</p>
        </AppShell>
      );
    }
    logFailure("Shiva sheet unavailable", error);
    return (
      <AppShell actor={actor} title="Shiva sheet">
        <LoadNotice what="This sheet" />
      </AppShell>
    );
  }
  const url = sheet.publicToken && !sheet.cancelled ? `${origin()}/v/s/${sheet.publicToken}` : null;
  const askRows = sheet.cancelled ? undefined : await loadAskRows(getDb(), actor, { groupId: sheet.id });
  return (
    <AppShell actor={actor} title={`Shiva for ${sheet.title}`}>
      {sheet.cancelled ? <p className="mb-4"><span className={tagQuiet}>Cancelled</span></p> : null}
      {sheet.careItemId ? <p className="mb-4 text-sm text-rubric">Linked to a care item you can see. Volunteers never see that.</p> : null}
      {url ? (
        <Section title="Share the link">
          <div className="mt-2">
            <ShareKit url={url} name="the shiva sheet" flyerHref={`/volunteers/sheets/${id}/flyer`} />
          </div>
        </Section>
      ) : null}

      {askRows !== undefined ? <AskRosterSection target={{ groupId: sheet.id }} rows={askRows} /> : null}

      <Section title="The evenings">
        <ol className="mt-2 flex flex-col gap-5">
          {sheet.evenings.map((e) => (
            <li key={e.id} data-testid="sheet-evening">
              <p className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-serif text-lg font-bold">{whenWords(e.date, e.timeWindow)}</span>
                <span className="text-base">
                  <span className="font-semibold">{towardTen(e.taken, e.peopleNeeded)}</span> toward ten
                  {e.status !== "open" ? ` · ${e.status === "done" ? "Done" : "Cancelled"}` : ""}
                </span>
              </p>
              <ClaimList claims={e.claims} editable={e.status === "open"} />
              <p className="mt-2">
                <Link href={`/volunteers/${e.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-action underline underline-offset-4">
                  Change or cancel this evening
                </Link>
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Who is bringing what">
        {sheet.bringing.length === 0 ? (
          <p className="mt-2 text-base text-rubric">Nobody has added anything yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="bringing">
            {sheet.bringing.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                <span className="min-w-0 break-words text-base">
                  <span className="font-semibold">{b.firstName}</span>: {b.line}
                </span>
                <ActionButton action={removeBringingAction} fields={{ groupId: sheet.id, bringingId: b.id }} label="Remove" className={btnQuiet} showOk={false} ariaLabel={`Remove ${b.firstName}'s line`} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {sheet.cancelled ? null : (
        <div className="mt-8">
          <ConfirmAction action={cancelSheetAction} fields={{ groupId: sheet.id }} label="Cancel the sheet" title="Cancel this sheet?" explain="The link stops working at once and every evening is cancelled." confirmLabel="Cancel the sheet" />
        </div>
      )}
    </AppShell>
  );
}
