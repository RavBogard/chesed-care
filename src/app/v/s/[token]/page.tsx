import Link from "next/link";
import { notFound } from "next/navigation";
import { PageSection, PublicFrame } from "@/components/meals/parts";
import { BringingForm } from "@/components/volunteers/bringing-form";
import { ClaimForm } from "@/components/volunteers/claim-form";
import { whenWords } from "@/components/volunteers/parts";
import { publicMetadata } from "@/components/public-meta";
import { btnPrimary, btnQuiet } from "@/components/ui";
import { PREVIEW_TITLE, towardTen } from "@/lib/volunteers-wording";
import { getDb } from "@/server/db/client";
import { signRenderStamp } from "@/server/meals/client-meta";
import { getPublicSheet } from "@/server/volunteers/public";

export const dynamic = "force-dynamic";
export const metadata = publicMetadata(PREVIEW_TITLE);

/**
 * A shiva sheet: the evenings, each a minyan slot counting toward ten, and a list of who is
 * bringing what (first names and a line). The place is given only after someone signs up.
 */
export default async function PublicSheetPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ evening?: string }> }) {
  const [{ token }, { evening }] = await Promise.all([params, searchParams]);
  const sheet = await getPublicSheet(getDb(), token);
  if (!sheet) notFound();
  const stamp = signRenderStamp(token, new Date());
  const chosen = sheet.evenings.find((e) => e.taskId === evening && !e.past && e.placesLeft > 0) ?? null;
  const firstOpen = sheet.evenings.find((e) => !e.past && e.placesLeft > 0);
  return (
    <PublicFrame congregation={sheet.congregation} title={`Shiva for ${sheet.title}`}>
      <p className="mt-3 max-w-prose whitespace-pre-line text-lg">{sheet.needed}</p>

      <PageSection id="evenings" heading="The evenings">
        <ol className="flex flex-col gap-2" aria-label="Evenings">
          {sheet.evenings.map((e) => {
            const open = !e.past && e.placesLeft > 0;
            return (
              <li key={e.taskId} data-testid={open ? "evening-open" : "evening-closed"} className={open ? "rounded-md border-2 border-action bg-surface px-4 py-3" : "rounded-md border border-rule-soft px-4 py-3"}>
                <p className="font-serif text-lg font-bold">{whenWords(e.date, e.timeWindow)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <p className="text-base">
                    <span className="font-semibold">{towardTen(e.taken, e.peopleNeeded)}</span> toward ten
                  </p>
                  {open ? (
                    <Link href={`?evening=${e.taskId}#sign-up`} scroll={false} className={e.taskId === firstOpen?.taskId ? btnPrimary : btnQuiet} aria-label={`I can come on ${whenWords(e.date, e.timeWindow)}`}>
                      I can come
                    </Link>
                  ) : (
                    <p className="text-base text-rubric">{e.past ? "This evening has passed." : "A minyan is covered. Thank you."}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </PageSection>

      {chosen ? (
        <PageSection id="sign-up" heading="Sign up">
          <ClaimForm token={token} taskId={chosen.taskId} stamp={stamp} what={`the minyan on ${whenWords(chosen.date, chosen.timeWindow)}`} />
        </PageSection>
      ) : null}

      <PageSection id="bringing" heading="Who is bringing what">
        {sheet.bringing.length === 0 ? (
          <p className="text-base text-rubric">Nobody has added anything yet.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-base" data-testid="bringing-list">
            {sheet.bringing.map((b, i) => (
              <li key={i} className="break-words">
                <span className="font-semibold">{b.firstName}</span>: {b.line}
              </li>
            ))}
          </ul>
        )}
        {sheet.bringingFull ? (
          <p className="mt-3 text-base">The list is full. Thank you.</p>
        ) : (
          <div className="mt-4">
            <BringingForm token={token} stamp={stamp} />
          </div>
        )}
      </PageSection>
    </PublicFrame>
  );
}
