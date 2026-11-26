import { Section } from "@/components/section";
import { btnQuiet, cardClass, nameClass } from "@/components/ui";
import { monthDay } from "@/lib/format";
import { BRIEF_WORDS } from "@/lib/team-wording";
import type { Brief } from "@/server/care/brief";
import { LoadNotice } from "@/components/load-notice";

const KIND = { call: "Call", visit: "Visit", text: "Text", other: "Contact" } as const;
const OUTCOME = { spoke: "spoke", no_answer: "no answer", left_message: "left a message", visited: "visited", texted: "texted" } as const;
const OCCASION = { yahrzeit: "Yahrzeit", shloshim: "End of shloshim", birthday: "Birthday", anniversary: "Anniversary" } as const;
const list = "mt-2 divide-y divide-rule-soft rounded-md border border-rule bg-surface";
const row = "px-4 py-2.5 text-base";

/** The brief as a page: calm, one column, and clean on paper (the shell is hidden when printing). */
export function BriefView({ brief }: { brief: Brief }) {
  const nothingOpen = brief.open.length === 0 && brief.restrictedElsewhere.length === 0;
  return (
    <article aria-label={BRIEF_WORDS.title} data-testid="brief">
      <header className="hidden print:block">
        <h1 className="font-serif text-2xl font-bold">{brief.name}</h1>
        <p className="text-sm">
          {BRIEF_WORDS.title} · {monthDay(brief.today)}
        </p>
      </header>
      <p className="mb-5 text-sm text-rubric [overflow-wrap:anywhere] print:hidden">
        {brief.household && brief.household !== brief.name ? `${brief.household} · ` : ""}
        {monthDay(brief.today)}
      </p>

      {brief.address ? (
        <Section title={BRIEF_WORDS.address}>
          <div className={`${cardClass} mt-2 flex flex-wrap items-center justify-between gap-3`} data-testid="brief-address">
            <p className="min-w-0 break-words text-base">
              {brief.address.lines.map((l, i) => (
                <span key={i} className="block">
                  {l}
                </span>
              ))}
            </p>
            {brief.address.mapsUrl ? (
              <a href={brief.address.mapsUrl} target="_blank" rel="noopener noreferrer" className={`${btnQuiet} print:hidden`} data-testid="brief-address-maps">
                {BRIEF_WORDS.openInMaps}
                <span className="sr-only">, opens in a new tab</span>
              </a>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section title={BRIEF_WORDS.open} empty={nothingOpen ? BRIEF_WORDS.nothingOpen : undefined}>
        {nothingOpen ? undefined : (
          <ul className={list}>
            {brief.open.map((o) => (
              <li key={o.itemId} className={row} data-testid="brief-open">
                <span className="font-semibold">{o.category}</span> · {o.status} · since {monthDay(o.since)}
                {o.heldBy ? ` · held by ${o.heldBy}` : ""}
              </li>
            ))}
            {brief.restrictedElsewhere.map((r, i) => (
              <li key={`r${i}`} className={row} data-testid="brief-restricted">
                {r.heldBy ? `In ${r.heldBy}'s care (restricted).` : BRIEF_WORDS.restricted}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {brief.contacts.length > 0 ? (
        <Section title={BRIEF_WORDS.contacts}>
          <ul className={list}>
            {brief.contacts.map((c, i) => (
              <li key={i} className={row} data-testid="brief-contact">
                <span className="font-semibold">{monthDay(c.date)}</span> · {KIND[c.kind as keyof typeof KIND] ?? "Contact"}
                {c.outcome ? `, ${OUTCOME[c.outcome as keyof typeof OUTCOME] ?? c.outcome}` : ""}
                {c.by ? ` · ${c.by}` : ""}
                {c.note ? <span className="block whitespace-pre-wrap text-ink">{c.note}</span> : null}
                {c.noteHidden ? <span className="block text-sm text-rubric">{BRIEF_WORDS.noteHidden}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.upcoming.length > 0 ? (
        <Section title={BRIEF_WORDS.next}>
          <ul className={list}>
            {brief.upcoming.map((f, i) => (
              <li key={i} className={row}>
                <span className="font-semibold">{monthDay(f.due)}</span> · {f.title}
                {f.heldBy ? ` · ${f.heldBy}` : ""}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.household_members.length > 0 ? (
        <Section title={BRIEF_WORDS.household}>
          <ul className={list}>
            {brief.household_members.map((m) => (
              <li key={m.contactId} className={`${row} ${nameClass}`}>
                {m.name}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.dates.length > 0 ? (
        <Section title={BRIEF_WORDS.dates}>
          <ul className={list}>
            {brief.dates.map((d, i) => (
              <li key={i} className={row}>
                <span className="font-semibold">{monthDay(d.date)}</span> · {OCCASION[d.type as keyof typeof OCCASION] ?? d.type} · {d.personName}
                {d.relationship ? ` (${d.relationship})` : ""}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.meals.length > 0 ? (
        <Section title={BRIEF_WORDS.meals}>
          <ul className={list}>
            {brief.meals.map((m, i) => (
              <li key={i} className={row}>
                {m.title} · {m.status}
                {m.coveredThrough ? ` · covered through ${monthDay(m.coveredThrough)}` : ""} · {m.openDates} open
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.volunteerTasks.length > 0 ? (
        <Section title={BRIEF_WORDS.volunteers}>
          <ul className={list}>
            {brief.volunteerTasks.map((t, i) => (
              <li key={i} className={row}>
                {monthDay(t.date)} · {t.kind.replace("_", " ")} for {t.forLabel} · {t.taken} of {t.peopleNeeded} taken
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.miSheberach.length > 0 ? (
        <Section title={BRIEF_WORDS.miSheberach}>
          <ul className={list}>
            {brief.miSheberach.map((e, i) => (
              <li key={i} className={row}>
                On the list since {monthDay(e.since)}
                {e.expiresOn ? `, comes off ${monthDay(e.expiresOn)}` : ", until further notice"}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.notKnown.length > 0 ? (
        <Section title={BRIEF_WORDS.notKnown}>
          <ul className={`${cardClass} mt-2 flex flex-col gap-1 text-base`} data-testid="brief-not-known">
            {brief.notKnown.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}

export function BriefUnavailable() {
  return <LoadNotice what="The brief" />;
}
