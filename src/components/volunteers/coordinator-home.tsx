import Link from "next/link";
import { takePracticalRequestAction } from "@/app/volunteers-actions";
import { LeadSteps } from "@/components/lead-steps";
import { Section } from "@/components/section";
import { btnPrimary, btnQuiet, nameClass, tagNew, tagQuiet } from "@/components/ui";
import { instantDate, longDate, shortDate } from "@/lib/format";
import { CHANGE_WORDS, daysLeftWords, HOME_EMPTY, HOME_SECTIONS } from "@/lib/roster-wording";
import { KIND_WORDS, placesWords } from "@/lib/volunteers-wording";
import type { CoordinatorHome } from "@/server/volunteers/home";
import { ActionButton } from "@/components/confirm-sheet";
import { ReferralList } from "./referral-list";

const list = "mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface";

/**
 * The coordinator's home, in the order they work: who is needed, their own steps, meals, what changed since yesterday,
 * and the week. Everything here came through the same visibility rules as the lists it summarises.
 */
export function CoordinatorHomeView({ home, canComplete }: { home: CoordinatorHome; canComplete: boolean }) {
  return (
    <div className="mb-8 flex flex-col gap-7" data-testid="coordinator-home">
      {home.asked.length > 0 ? (
        <Section title={HOME_SECTIONS.asked}>
          <ul className={list} data-testid="home-asked">
            {home.asked.map((a) => (
              <li key={a.id} className="px-4 py-3" data-testid="home-asked-row">
                <p className="text-sm text-rubric">{instantDate(a.createdAt)}</p>
                <p className={`${nameClass} break-words`}>{a.about}</p>
                <p className="mt-1 whitespace-pre-line break-words text-base">{a.what}</p>
                <p className="mt-1 break-words text-base text-rubric">
                  From {a.sender} · {a.contact}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {a.takenByName === null ? (
                    <ActionButton action={takePracticalRequestAction} fields={{ proposalId: a.id }} label="I'll take this" className={btnPrimary} showOk={false} />
                  ) : (
                    <span className="text-base font-semibold">Taken by {a.takenByName}</span>
                  )}
                  {a.takenByMe ? (
                    <Link href="/volunteers/new" className={btnQuiet}>
                      Make a task
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {home.referrals.length > 0 ? <ReferralList referrals={home.referrals} /> : null}

      <Section title={HOME_SECTIONS.needs}>
        {home.needsSomeone.length === 0 ? (
          <p className="mt-2 text-base text-rubric">{HOME_EMPTY.needs}</p>
        ) : (
          <ul className={list} data-testid="home-needs">
            {home.needsSomeone.map((n) => (
              <li key={n.id} className="px-4 py-3" data-testid="home-need">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <Link href={n.href} className={`${nameClass} min-w-0 break-words underline decoration-control underline-offset-4`}>
                    {KIND_WORDS[n.kind]} for {n.label}
                  </Link>
                  <span className={n.daysLeft <= 1 ? tagNew : tagQuiet}>{daysLeftWords(n.daysLeft)}</span>
                </div>
                <p className="mt-1 text-base text-rubric">
                  {longDate(n.date)}
                  {n.timeWindow ? `, ${n.timeWindow}` : ""} · {placesWords(n.placesLeft)}
                </p>
                <p className="mt-2">
                  <Link href={n.askHref} className={btnQuiet}>
                    Ask the roster
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div id="mitzvah-corps" className="scroll-mt-20">
        <Section title={HOME_SECTIONS.steps}>
          {home.mySteps.length === 0 ? (
            <p className="mt-2 text-base text-rubric">{HOME_EMPTY.steps}</p>
          ) : (
            <LeadSteps
              today={home.today}
              canComplete={canComplete}
              steps={home.mySteps.map((s) => ({ id: s.id, person: s.person, title: s.title, dueDate: s.dueDate, done: false, outcomeNote: null, mealsHref: s.mealsHref, corpsNote: s.corpsNote }))}
            />
          )}
        </Section>
      </div>

      {home.meals !== null ? (
        <Section title={HOME_SECTIONS.meals}>
          {home.meals.length === 0 ? (
            <p className="mt-2 text-base text-rubric">{HOME_EMPTY.meals}</p>
          ) : (
            <ul className={list} data-testid="home-meals">
              {home.meals.map((m) => (
                <li key={m.id} className="px-4 py-3" data-testid="home-meal">
                  <Link href={m.href} className={`${nameClass} break-words underline decoration-control underline-offset-4`}>
                    {m.title}
                  </Link>
                  <p className="mt-1 text-base text-rubric">
                    {m.openNights.length === 1 ? "1 open night" : `${m.openNights.length} open nights`}: {m.openNights.map((n) => shortDate(n.date)).join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Section title={HOME_SECTIONS.changes}>
        {home.changes.length === 0 ? (
          <p className="mt-2 text-base text-rubric">{HOME_EMPTY.changes}</p>
        ) : (
          <ul className={list} data-testid="home-changes">
            {home.changes.map((c, i) => (
              <li key={`${c.kind}-${c.at.getTime()}-${i}`} className="px-4 py-2.5 text-base" data-testid="home-change">
                <Link href={c.href} className="underline decoration-control underline-offset-4">
                  {CHANGE_WORDS[c.kind](c.firstName ?? "Someone", c.label)}
                </Link>
                {c.note ? <span className="block text-sm text-rubric">&ldquo;{c.note}&rdquo;</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={HOME_SECTIONS.week}>
        {home.thisWeek.length === 0 ? (
          <p className="mt-2 text-base text-rubric">{HOME_EMPTY.week}</p>
        ) : (
          <ul className={list} data-testid="home-week">
            {home.thisWeek.map((d) => (
              <li key={d.date} className="px-4 py-3" data-testid="home-week-day">
                <h3 className="text-sm font-semibold">{longDate(d.date)}</h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {d.items.map((it) => (
                    <li key={it.id} className="text-base">
                      <Link href={it.href} className="underline decoration-control underline-offset-4">
                        {KIND_WORDS[it.kind]} for {it.label}
                      </Link>
                      {it.timeWindow ? <span className="text-rubric">, {it.timeWindow}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
