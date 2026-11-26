import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { careViewFor } from "@/app/people/care-view";
import { AddressBlock } from "@/components/address-block";
import { BackLink } from "@/components/back-link";
import { AddToAgenda } from "@/components/agenda/add-to-agenda";
import { canLogContact, LOG_INLINE_ID, LogContactForm, PersonActions } from "@/components/person-actions";
import { loadMealsLine, PersonMeals } from "@/components/meals/person-meals";
import { loadVolunteerTasks, PersonVolunteers } from "@/components/volunteers/person-volunteers";
import { loadVisitingState, PersonVisiting } from "@/components/volunteers/visiting-add";
import { loadReferrals, PersonReferral } from "@/components/volunteers/referral-add";
import { ContactHistory, PersonCare } from "@/components/person-care";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { Hebrew } from "@/components/hebrew";
import { KindTag } from "@/components/kind-tag";
import { btnQuiet, cardClass, facingLine, nameClass, noticeClass, rubric } from "@/components/ui";
import { monthDay } from "@/lib/format";
import { BRIEF_WORDS } from "@/lib/team-wording";
import { canSeeLifecycle, type Actor } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { markKey } from "@/server/care/occasion-marks";
import { CanonicalContactId, getPersonPage, type PersonPage } from "@/server/care/person-page";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { normalizePhone } from "@/server/lifecycle/sms";
import { getSalesforce } from "@/server/salesforce";
import { LoadNotice } from "@/components/load-notice";
import { logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";

/** The page is read once per request, however many times the title and the body ask for it. */
const requestMemo = cache(() => new Map<string, Promise<PersonPage>>());
function loadPage(actor: Actor, contactId: string): Promise<PersonPage> {
  const memo = requestMemo();
  const key = `${actor.id}|${contactId}`;
  let found = memo.get(key);
  if (!found) {
    found = getPersonPage({ db: getDb(), sf: getSalesforce, now: new Date() }, actor, contactId);
    memo.set(key, found);
  }
  return found;
}

/** The tab title is the person's name. Any failure here falls back; the page itself shows the real error or redirect. */
export async function generateMetadata({ params }: { params: Promise<{ contactId: string }> }): Promise<Metadata> {
  try {
    const actor = actorOrRedirect(await getViewer());
    const page = await loadPage(actor, (await params).contactId);
    if (page.name) return { title: `${page.name} · CRC Care` };
  } catch {
    // Not found, redirect, signed out or unavailable: the generic title.
  }
  return { title: "Person · CRC Care" };
}

export default async function PersonPageRoute({ params, searchParams }: { params: Promise<{ contactId: string }>; searchParams: Promise<{ action?: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  const [{ contactId }, { action }] = await Promise.all([params, searchParams]);

  let page: PersonPage | null = null;
  try {
    page = await loadPage(actor, contactId);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    if (error instanceof CanonicalContactId) redirect(`/people/${error.contactId}`);
    logFailure("Person page unavailable", error);
  }

  if (!page) {
    return (
      <AppShell actor={actor} title="Person">
        <LoadNotice what="This page" />
      </AppShell>
    );
  }

  const [view, mealsLines, volunteerTasks, visiting, referrals] = await Promise.all([careViewFor(actor, page), loadMealsLine(actor, { sfContactId: page.contactId, sfAccountId: page.accountId }), loadVolunteerTasks(actor, page.careItems.map((i) => i.id)), page.name ? loadVisitingState(actor, { sfContactId: page.contactId, displayName: page.name }) : null, page.name ? loadReferrals(actor, { sfContactId: page.contactId }) : null]);
  const phones = page.person?.phones ?? [];
  const person = page.person;
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  const repeatsName = !!person?.household && norm(person.household) === norm(page.name);
  // A laptop writes the note beside the history: the form is on the page, in a second column.
  const logInline = !!page.name && canLogContact(page, actor);

  return (
    <AppShell actor={actor} title={page.name || "Person"} facing={person?.hebrewName} wide={logInline}>
      <div className={logInline ? "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start lg:gap-8" : undefined}>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <BackLink fallback="/find" />
            {page.name && canSeeLifecycle(actor) ? (
              <span className="flex flex-wrap items-center gap-2">
                <AddToAgenda about={page.name} sfContactId={page.contactId} displayName={page.name} idPrefix="agenda-person" />
                <Link href={`/people/${page.contactId}/brief`} className={btnQuiet}>
                  {BRIEF_WORDS.button}
                </Link>
              </span>
            ) : null}
          </div>
          {person?.household && !repeatsName ? <p className="mb-5 text-sm text-rubric">{person.household}</p> : null}

          {page.salesforce === "unavailable" ? <p className={`${noticeClass} mb-5`}>Phone numbers and dates from Salesforce could not be loaded just now. Care notes below are still here.</p> : null}
          {page.salesforce === "missing" ? <p className={`${noticeClass} mb-5`}>This person was not found in Salesforce. Care notes below are still here.</p> : null}

          {phones.length > 0 ? (
            <ul className="mb-5 flex flex-col gap-2" aria-label="Phone numbers">
              {phones.map((p) => {
                const n = normalizePhone(p.number);
                return (
                  <li key={`${p.kind}|${p.number}`} className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
                    <span className="min-w-0 break-words">
                      <span className="block text-base">{p.number}</span>
                      <span className="block text-sm capitalize text-rubric">{p.kind}</span>
                    </span>
                    {n ? (
                      <span className="flex flex-wrap gap-2">
                        <a href={`tel:${n}`} className={btnQuiet} aria-label={`Call ${p.number}`}>
                          Call
                        </a>
                        <a href={`sms:${n}`} className={btnQuiet} aria-label={`Text ${p.number}`}>
                          Text
                        </a>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <AddressBlock address={person?.address ?? null} />

          {page.name ? (
            <div className="mb-2">
              <PersonActions page={page} actor={actor} open={action} logInline={logInline} />
            </div>
          ) : null}

          <PersonCare view={view} actor={actor} />

          {page.name ? <PersonMeals actor={actor} lines={mealsLines} startHref={`/meals/new?contact=${page.contactId}`} /> : null}

          <PersonVolunteers tasks={volunteerTasks} careItemId={page.careItems[0]?.id ?? null} restrictedItemIds={page.careItems.filter((i) => i.restricted).map((i) => i.id)} />

          {page.name ? <PersonVisiting state={visiting} person={{ sfContactId: page.contactId, displayName: page.name }} /> : null}

          {page.name ? <PersonReferral state={referrals} person={{ sfContactId: page.contactId }} /> : null}

          {person && person.occasions.length > 0 ? (
            <Section title="Upcoming dates">
              <ul className="mt-2 divide-y divide-rule-soft rounded-md border border-rule bg-surface">
                {person.occasions.map((o) => {
                  const done = page.doneMarks.includes(markKey({ occasionType: o.type, subjectId: o.subjectId, sfAccountId: o.accountId ?? "", year: Number(o.date.slice(0, 4)) }));
                  return (
                    <li key={`${o.type}|${o.subjectId}|${o.date}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm" data-testid="person-date">
                      <span className="font-semibold tabular-nums">{monthDay(o.date)}</span>
                      {/* The kind as on its card: the icon and the word on the kind's fill. */}
                      <KindTag type={o.type} />
                      <span className={`${nameClass} min-w-0 break-words`}>{o.personName}</span>
                      <span className="ml-auto flex max-w-full flex-wrap items-baseline justify-end gap-x-3">
                        {o.type === "yahrzeit" && o.hebrewDeathDate ? <Hebrew className="text-action">{o.hebrewDeathDate}</Hebrew> : null}
                        {done ? <span className="font-semibold text-done">Done</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          ) : null}

          {person && person.members.length > 0 ? (
            <Section title="Household">
              <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface">
                {person.members.map((m) => (
                  <li key={m.contactId}>
                    <Link href={`/people/${m.contactId}`} className={`${facingLine} min-h-11 px-4 py-2.5 transition-colors hover:bg-tint focus-visible:-outline-offset-3`}>
                      <span className={`${nameClass} min-w-0 break-words underline decoration-control underline-offset-4`}>{m.name}</span>
                      {m.hebrewName ? <Hebrew className="text-action">{m.hebrewName}</Hebrew> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

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
