import type { Metadata } from "next";
import Link from "next/link";
import { BRIEF_WORDS } from "@/lib/team-wording";
import { notFound, redirect } from "next/navigation";
import { careViewFor } from "@/app/people/care-view";
import { AddressBlock } from "@/components/address-block";
import { BackLink } from "@/components/back-link";
import { AddToAgenda } from "@/components/agenda/add-to-agenda";
import { OUTSIDE_EDIT_WORDS } from "@/lib/clergy-wording";
import { canLogContact, LOG_INLINE_ID, LogContactForm, PersonActions } from "@/components/person-actions";
import { loadMealsLine, PersonMeals } from "@/components/meals/person-meals";
import { loadVolunteerTasks, PersonVolunteers } from "@/components/volunteers/person-volunteers";
import { loadVisitingState, PersonVisiting } from "@/components/volunteers/visiting-add";
import { loadReferrals, PersonReferral } from "@/components/volunteers/referral-add";
import { ContactHistory, PersonCare } from "@/components/person-care";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet, cardClass, rubric, tagQuiet } from "@/components/ui";
import { canManageOutsidePeople } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { outsideAddress } from "@/server/care/outside-people";
import { getOutsidePersonPage, type OutsidePersonPage } from "@/server/care/person-page";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { normalizePhone } from "@/server/lifecycle/sms";
import { LoadNotice } from "@/components/load-notice";
import { logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Person · CRC Care" };

/**
 * Someone cared for who is not in Salesforce. The same care, follow-up and contact actions as
 * any person; nothing from Salesforce (no dates, no household), only the name, a phone and a
 * short note kept in this app.
 */
export default async function OutsidePersonRoute({ params, searchParams }: { params: Promise<{ outsideId: string }>; searchParams: Promise<{ action?: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!canManageOutsidePeople(actor)) redirect("/care");
  const [{ outsideId }, { action }] = await Promise.all([params, searchParams]);

  let page: OutsidePersonPage | null = null;
  try {
    page = await getOutsidePersonPage({ db: getDb(), now: new Date() }, actor, outsideId);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    logFailure("Outside person page unavailable", error);
  }
  if (!page) {
    return (
      <AppShell actor={actor} title="Person">
        <LoadNotice what="This page" />
      </AppShell>
    );
  }

  const [view, mealsLines, volunteerTasks, visiting, referrals] = await Promise.all([careViewFor(actor, page), loadMealsLine(actor, { outsidePersonId: outsideId }), loadVolunteerTasks(actor, page.careItems.map((i) => i.id)), loadVisitingState(actor, { outsidePersonId: outsideId, displayName: page.name }), loadReferrals(actor, { outsidePersonId: outsideId })]);
  const number = page.person.phone ? normalizePhone(page.person.phone) : null;
  const logInline = canLogContact(page, actor);
  return (
    <AppShell actor={actor} title={page.name} wide={logInline}>
      <div className={logInline ? "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start lg:gap-8" : undefined}>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <BackLink fallback="/find" />
            <span className="flex flex-wrap items-center gap-2">
            <Link href={`/people/outside/${outsideId}/edit`} className={btnQuiet} data-testid="outside-edit-link">
              {OUTSIDE_EDIT_WORDS.link}
            </Link>
            <AddToAgenda about={page.name} outsidePersonId={outsideId} displayName={page.name} idPrefix="agenda-person" />
            <Link href={`/people/outside/${outsideId}/brief`} className={btnQuiet}>
              {BRIEF_WORDS.button}
            </Link>
            </span>
          </div>
          <p className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-rubric">
            <span className={tagQuiet}>Not in Salesforce</span>
            {page.person.note ? <span className="min-w-0 break-words">{page.person.note}</span> : null}
          </p>

          {page.person.phone ? (
            <ul className="mb-5 flex flex-col gap-2" aria-label="Phone numbers">
              <li className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
                <span className="min-w-0 break-words text-base">{page.person.phone}</span>
                {number ? (
                  <span className="flex flex-wrap gap-2">
                    <a href={`tel:${number}`} className={btnQuiet} aria-label={`Call ${page.person.phone}`}>
                      Call
                    </a>
                    <a href={`sms:${number}`} className={btnQuiet} aria-label={`Text ${page.person.phone}`}>
                      Text
                    </a>
                  </span>
                ) : null}
              </li>
            </ul>
          ) : null}

          <AddressBlock address={outsideAddress(page.person)} />

          <div className="mb-2">
            <PersonActions page={page} actor={actor} open={action} logInline={logInline} />
          </div>
          <PersonCare view={view} actor={actor} />
          <PersonMeals actor={actor} lines={mealsLines} startHref={`/meals/new?outside=${outsideId}`} />
          <PersonVolunteers tasks={volunteerTasks} careItemId={page.careItems[0]?.id ?? null} restrictedItemIds={page.careItems.filter((i) => i.restricted).map((i) => i.id)} />
          <PersonVisiting state={visiting} person={{ outsidePersonId: outsideId, displayName: page.name }} />
          <PersonReferral state={referrals} person={{ outsidePersonId: outsideId }} />
          <ContactHistory view={view} actor={actor} />
        </div>
        {logInline ? (
          <section id={LOG_INLINE_ID} aria-label="Log a contact" className="max-lg:hidden lg:sticky lg:top-8 lg:max-h-[calc(100dvh-4rem)] lg:overflow-y-auto short:static! short:max-h-none!">
            <h2 className={rubric}>Log a contact</h2>
            <div className={`${cardClass} mt-2`}>
              <LogContactForm page={page} actor={actor} idPrefix={LOG_INLINE_ID} />
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
