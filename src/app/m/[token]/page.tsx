import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { DateHead, FoodFacts, FoodTag, nightLabel, notesByDate, PageSection, PublicFrame } from "@/components/meals/parts";
import { publicMetadata } from "@/components/public-meta";
import { SignupForm } from "@/components/meals/signup-form";
import { btnPrimary, btnQuiet } from "@/components/ui";
import { ALL_COVERED, ETIQUETTE, heading, NOT_OPEN } from "@/lib/meals-wording";
import { getDb } from "@/server/db/client";
import { CONGREGATION } from "@/server/meals/core";
import { calendarNotes } from "@/server/meals/calendar-notes";
import { signRenderStamp } from "@/server/meals/client-meta";
import { getPublicMealPage } from "@/server/meals/public";

export const dynamic = "force-dynamic";

const load = cache((token: string) => getPublicMealPage(getDb(), token));

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  try {
    const page = await load((await params).token);
    return publicMetadata(page?.title ? heading(page.title) : "Mitzvah Meals");
  } catch {
    return publicMetadata("Mitzvah Meals");
  }
}

/** The public page of a family's meals: no account, no menu. Everything on it passed the allow-list in server/meals/public.ts. */
export default async function PublicMealsPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ night?: string }> }) {
  const [{ token }, { night }] = await Promise.all([params, searchParams]);
  const page = await load(token);
  if (!page) notFound();
  if (page.status !== "live") {
    return (
      <PublicFrame congregation={CONGREGATION} title={heading(page.title)}>
        <p className="mt-4 text-lg" data-testid="not-open">
          {NOT_OPEN[page.status]}
        </p>
      </PublicFrame>
    );
  }

  const upcoming = page.dates.filter((d) => !d.past);
  const notes = notesByDate(calendarNotes(upcoming.map((d) => d.date)));
  const open = upcoming.filter((d) => !d.taken);
  const chosen = open.find((d) => d.slotId === night) ?? null;
  const stamp = signRenderStamp(token, new Date());
  const facts = { foodFor: page.foodFor, kashrut: page.kashrut, dietary: page.dietary, allergies: page.allergies, dropOffWindow: page.dropOffWindow };

  return (
    <PublicFrame congregation={page.congregation} title={heading(page.title)}>
      {page.note ? <p className="mt-3 max-w-prose whitespace-pre-line text-lg">{page.note}</p> : null}

      <PageSection id="know" heading="What to know before you cook">
        <FoodFacts facts={facts} />
      </PageSection>

      <PageSection id="nights" heading="The evenings">
        {upcoming.length === 0 ? (
          <p className="text-base">There are no dates on this page just now.</p>
        ) : (
          <>
            {open.length === 0 ? (
              <p className="mb-3 font-serif text-xl font-bold" data-testid="all-covered">
                {ALL_COVERED}
              </p>
            ) : null}
            <ol className="flex flex-col gap-2" aria-label="Dates">
              {upcoming.map((d) => {
                const isFirstOpen = open[0]?.slotId === d.slotId;
                return (
                  <li key={d.slotId} data-testid={d.taken ? "night-taken" : "night-open"} className={d.taken ? "rounded-md border border-rule-soft px-4 py-3" : "rounded-md border-2 border-action bg-surface px-4 py-3"}>
                    <DateHead date={d.date} meal={d.meal} note={notes.get(d.date)} />
                    {d.taken ? (
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
                        <span>
                          {d.taken.firstName ?? "Someone"} is {d.taken.kind === "delivery" ? "sending a delivery" : "bringing"}
                          {d.taken.bringing ? `: ${d.taken.bringing}` : ""}
                        </span>
                        <FoodTag foodType={d.taken.foodType} />
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                        <p className="text-lg font-bold text-action">Open</p>
                        <a href={`?night=${d.slotId}#sign-up`} className={isFirstOpen ? btnPrimary : btnQuiet} aria-label={`Take ${nightLabel(d.date, d.meal)}`}>
                          Take this night
                        </a>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </PageSection>

      {chosen ? (
        <PageSection id="sign-up" heading="Sign up">
          <div className="mb-4">
            <FoodFacts facts={facts} headingLevel="h3" />
          </div>
          <SignupForm token={token} slotId={chosen.slotId} night={nightLabel(chosen.date, chosen.meal)} stamp={stamp} changeHref="#nights" />
        </PageSection>
      ) : null}

      {page.deliveryPlaces || page.giftCards ? (
        <PageSection id="other" heading="Other ways to help">
          <div className="flex flex-col gap-4 text-base">
            {page.deliveryPlaces ? (
              <div>
                <h3 className="font-semibold">Send a delivery</h3>
                <p className="whitespace-pre-line">{page.deliveryPlaces}</p>
                <p className="text-sm text-rubric">Choose an open night above and tell us you are sending a delivery.</p>
              </div>
            ) : null}
            {page.giftCards ? (
              <div>
                <h3 className="font-semibold">Gift cards</h3>
                <p className="whitespace-pre-line">{page.giftCards}</p>
                {page.giftCardEmail ? (
                  <p>
                    Send them to{" "}
                    <a href={`mailto:${page.giftCardEmail}`} className="font-medium text-action underline underline-offset-4">
                      {page.giftCardEmail}
                    </a>
                    .
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </PageSection>
      ) : null}

      <PageSection id="etiquette" heading="Bringing a meal">
        <ul className="list-disc space-y-1 pl-5 text-base">
          {ETIQUETTE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </PageSection>
    </PublicFrame>
  );
}
