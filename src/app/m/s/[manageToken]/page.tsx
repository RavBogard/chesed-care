import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cancelSignupAction } from "@/app/m/actions";
import { ChangeForm } from "@/components/meals/change-form";
import { CopyButton } from "@/components/copy-button";
import { FoodFacts, nightLabel, PageSection, PublicFrame } from "@/components/meals/parts";
import { publicMetadata } from "@/components/public-meta";
import { ConfirmAction } from "@/components/confirm-sheet";
import { btnPrimary } from "@/components/ui";
import { longDate } from "@/lib/format";
import { heading, mealWord } from "@/lib/meals-wording";
import { getDb } from "@/server/db/client";
import { CONGREGATION } from "@/server/meals/core";
import { getMySignup } from "@/server/meals/public";

export const dynamic = "force-dynamic";

// The helper's own page says nothing in a link preview: the title of the page only, no date, no name.
export const metadata: Metadata = publicMetadata("Mitzvah Meals");

const WHY = {
  cancelled: "This sign-up has been cancelled.",
  withdrawn: "This night is no longer needed. Thank you for offering to help. The organiser may be in touch.",
  paused: "This page is resting for now, so nothing is needed from you at the moment. Please check back later.",
  ended: "This page has ended. Thank you for your kindness.",
} as const;

/** A helper's own page, reached by the secret link they were given when they signed up. */
export default async function MySignupPage({ params, searchParams }: { params: Promise<{ manageToken: string }>; searchParams: Promise<{ new?: string }> }) {
  const [{ manageToken }, { new: fresh }] = await Promise.all([params, searchParams]);
  const mine = await getMySignup(getDb(), manageToken);
  if (!mine) notFound();

  if (mine.state !== "active") {
    return (
      <PublicFrame congregation={CONGREGATION} title={heading(mine.title)}>
        <p className="mt-4 text-lg" data-testid="signup-state">
          {WHY[mine.state]}
        </p>
        {mine.thanks ? <Thanks text={mine.thanks.text} /> : null}
      </PublicFrame>
    );
  }

  const d = mine.details;
  return (
    <PublicFrame congregation={CONGREGATION} title={heading(d.title)}>
      <p className="mt-3 text-xl font-semibold" data-testid="signup-confirmation">
        {fresh ? "Thank you. " : ""}You are {mine.kind === "delivery" ? "sending a delivery" : "bringing"} {mealWord(d.meal).toLowerCase()} on {longDate(d.date)}.
      </p>
      {mine.thanks ? <Thanks text={mine.thanks.text} /> : null}

      <PageSection id="where" heading="Where and when">
        <dl className="flex flex-col gap-3 text-base">
          {d.dropOffAddress ? (
            <div>
              <dt className="text-sm font-semibold">Address</dt>
              <dd className="whitespace-pre-line break-words text-lg" data-testid="address">
                {d.dropOffAddress}
              </dd>
            </div>
          ) : null}
          {d.dropOffWindow ? (
            <div>
              <dt className="text-sm font-semibold">Drop-off window</dt>
              <dd>{d.dropOffWindow}</dd>
            </div>
          ) : null}
          {d.dropOffInstructions ? (
            <div>
              <dt className="text-sm font-semibold">Instructions</dt>
              <dd className="whitespace-pre-line break-words">{d.dropOffInstructions}</dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-4">
          <a href={`/m/s/${manageToken}/calendar.ics`} className={btnPrimary}>
            Add to your calendar
          </a>
        </p>
      </PageSection>

      <PageSection id="know" heading="What to know before you cook">
        <FoodFacts facts={{ foodFor: d.foodFor, kashrut: d.kashrut, dietary: d.dietary, allergies: d.allergies, dropOffWindow: null }} />
      </PageSection>

      <PageSection id="link" heading="Your link">
        <p className="mb-3 text-base">Keep this page. It is how you change or cancel your night, and it is the only way back to it. Anyone who has the link can change your sign-up, so please keep it to yourself.</p>
        <CopyButton link text={`/m/s/${manageToken}`} label="Copy my link" failed="Could not copy. Press and hold the link to copy it by hand." />
      </PageSection>

      <PageSection id="change" heading="Change your sign-up">
        <ChangeForm
          key={`${mine.kind}|${mine.bringing}|${mine.foodType}|${mine.note}`}
          token={manageToken}
          current={{ kind: mine.kind, bringing: mine.bringing, foodType: mine.foodType, note: mine.note }}
          nights={mine.openDates.map((n) => ({ slotId: n.slotId, label: nightLabel(n.date, n.meal) }))}
        />
      </PageSection>

      <PageSection id="cancel" heading="Cannot make it?">
        <p className="mb-3 text-base">That is all right. Giving the night back lets someone else take it.</p>
        <ConfirmAction action={cancelSignupAction} fields={{ token: manageToken }} label="Cancel my night" title="Give this night back?" explain="The night opens again for someone else. You can sign up for another night from the page you were sent." confirmLabel="Yes, cancel my night" />
      </PageSection>
    </PublicFrame>
  );
}

function Thanks({ text }: { text: string }) {
  return (
    <section aria-labelledby="thanks-h" className="mt-6 rounded-md bg-done-band p-4 text-done">
      <h2 id="thanks-h" className="font-serif text-lg font-bold">
        A thank you from the family
      </h2>
      <p className="mt-1 whitespace-pre-line text-base">{text}</p>
    </section>
  );
}
