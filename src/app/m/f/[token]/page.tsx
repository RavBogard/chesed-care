import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FamilyFoodForm, EndButton, PauseButton, ResumeButton } from "@/components/meals/family-forms";
import { DateHead, FoodTag, notesByDate, PageSection, PublicFrame } from "@/components/meals/parts";
import { publicMetadata } from "@/components/public-meta";
import { ThankForm } from "@/components/meals/thank-form";
import { heading } from "@/lib/meals-wording";
import { getDb } from "@/server/db/client";
import { calendarNotes } from "@/server/meals/calendar-notes";
import { CONGREGATION } from "@/server/meals/core";
import { getFamilyView, type FamilyDate } from "@/server/meals/family";

export const dynamic = "force-dynamic";

// The family's own link says nothing in a preview.
export const metadata: Metadata = publicMetadata("Mitzvah Meals");

function Helper({ d, token, thanks }: { d: FamilyDate; token: string; thanks: boolean }) {
  const h = d.helper;
  if (!h) return null;
  const name = [h.firstName, h.lastName].filter(Boolean).join(" ") || "A helper";
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
      <span>
        {name} is {h.kind === "delivery" ? "sending a delivery" : "bringing"}
        {h.bringing ? `: ${h.bringing}` : ""}
      </span>
      <FoodTag foodType={h.foodType} />
      {thanks ? h.thanked ? <span className="text-sm font-semibold text-done">Thanked</span> : <ThankForm token={token} signupId={h.signupId} name={h.firstName ?? "this helper"} /> : null}
    </p>
  );
}

/** The family's own private page: who is coming tonight and this week, the food needs, and a way to pause, end or thank. */
export default async function FamilyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getFamilyView(getDb(), token);
  if (!view) notFound();

  if (view.status === "ended") {
    return (
      <PublicFrame congregation={CONGREGATION} title={heading(view.title)}>
        <p className="mt-3 text-lg">This page has ended. Thank you for letting us help. You can still thank the people who brought meals.</p>
        <PageSection id="helped" heading="Who helped">
          {view.helped.length === 0 ? (
            <p>Nobody had signed up.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {view.helped.map((d) => (
                <li key={d.slotId} className="rounded-md border border-rule-soft px-4 py-3">
                  <DateHead date={d.date} meal={d.meal} />
                  <Helper d={d} token={token} thanks />
                </li>
              ))}
            </ul>
          )}
        </PageSection>
      </PublicFrame>
    );
  }

  const week = view.dates.filter((d) => !d.past);
  const notes = notesByDate(calendarNotes(week.map((d) => d.date)));
  return (
    <PublicFrame congregation={CONGREGATION} title={heading(view.title)}>
      {view.status === "paused" ? (
        <div className="mt-4 rounded-md bg-alert-band p-4 text-alert" data-testid="paused">
          <p className="text-base font-semibold">This page is paused. Nobody can sign up for now.</p>
          {view.canResume ? (
            <div className="mt-3">
              <ResumeButton token={token} />
            </div>
          ) : (
            <p className="mt-1 text-sm">It was paused by the organiser, who can open it again.</p>
          )}
        </div>
      ) : null}
      {view.status === "draft" ? <p className="mt-4 text-base">This page is not open to helpers yet.</p> : null}

      <PageSection id="tonight" heading="Tonight">
        {view.tonight.length === 0 ? (
          <p className="text-base" data-testid="nobody-tonight">
            Nobody is coming tonight.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.tonight.map((d) => (
              <li key={d.slotId} className="rounded-md border-2 border-action bg-surface px-4 py-3">
                <DateHead date={d.date} meal={d.meal} note={notes.get(d.date)} />
                {d.helper ? <Helper d={d} token={token} thanks /> : <p className="mt-1 text-base text-rubric">Nobody has signed up for this one yet.</p>}
              </li>
            ))}
          </ul>
        )}
      </PageSection>

      <PageSection id="week" heading="The week">
        {week.length === 0 ? (
          <p className="text-base">There are no more dates on the page.</p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Dates">
            {week.map((d) => (
              <li key={d.slotId} className="rounded-md border border-rule-soft px-4 py-3">
                <DateHead date={d.date} meal={d.meal} note={notes.get(d.date)} />
                {d.helper ? <Helper d={d} token={token} thanks /> : <p className="mt-1 text-base text-rubric">Open. Nobody has signed up yet.</p>}
              </li>
            ))}
          </ol>
        )}
      </PageSection>

      <PageSection id="food" heading="Food needs">
        <FamilyFoodForm token={token} values={{ foodFor: view.foodFor, kashrut: view.kashrut, dietary: view.dietary, allergies: view.allergies, dropOffWindow: view.dropOffWindow, dropOffInstructions: view.dropOffInstructions }} />
      </PageSection>

      <PageSection id="stop" heading="Pause or end">
        <p className="mb-3 text-base">You are always in charge of this page. Pausing stops new sign-ups for now. Ending closes it for good.</p>
        <div className="flex flex-wrap gap-2">
          {view.status === "live" ? <PauseButton token={token} /> : null}
          {view.status !== "draft" ? <EndButton token={token} /> : null}
        </div>
      </PageSection>
    </PublicFrame>
  );
}
