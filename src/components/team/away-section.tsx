import { clearAwayAction, setAwayAction } from "@/app/away-actions";
import { AWAY_WORDS } from "@/lib/clergy-wording";
import { monthDay } from "@/lib/format";
import type { AwaySetting } from "@/server/team/away";
import { ActionForm } from "../action-form";
import { Section } from "../section";
import { btnPrimary, btnQuiet, cardClass, inputClass, labelClass } from "../ui";
import { ActionButton } from "@/components/confirm-sheet";

/** Settings: "I'm away" for oneself (the owner may set it for a colleague). From a date to a date, with an optional colleague covering. */
export function AwaySection({ people, coverChoices, today }: { people: AwaySetting[]; coverChoices: { id: string; name: string }[]; today: string }) {
  if (people.length === 0) return null;
  return (
    <Section title={AWAY_WORDS.title}>
      <p className="mt-2 max-w-prose text-sm text-rubric">{AWAY_WORDS.intro}</p>
      <ul className="mt-3 flex flex-col gap-3">
        {people.map((p) => (
          <li key={p.userId} className={cardClass} data-testid="away-setting">
            {people.length > 1 ? <p className="mb-2 text-base font-semibold [overflow-wrap:anywhere]">{p.self ? `${p.name} (you)` : p.name}</p> : null}
            {p.away ? (
              <p className="mb-2 text-sm text-rubric">
                {monthDay(p.away.from)} to {monthDay(p.away.until)}
              </p>
            ) : null}
            <ActionForm action={setAwayAction} className="flex flex-col gap-3" closeSheetOnOk={false}>
              <input type="hidden" name="userId" value={p.userId} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`away-from-${p.userId}`} className={labelClass}>
                    {AWAY_WORDS.from}
                  </label>
                  <input id={`away-from-${p.userId}`} name="from" type="date" required min={today} defaultValue={p.away?.from ?? today} className={inputClass} />
                </div>
                <div>
                  <label htmlFor={`away-until-${p.userId}`} className={labelClass}>
                    {AWAY_WORDS.until}
                  </label>
                  <input id={`away-until-${p.userId}`} name="until" type="date" required min={today} defaultValue={p.away?.until ?? ""} className={inputClass} />
                </div>
              </div>
              <div>
                <label htmlFor={`away-cover-${p.userId}`} className={labelClass}>
                  {AWAY_WORDS.cover}
                </label>
                <select id={`away-cover-${p.userId}`} name="coverUserId" className={inputClass} defaultValue={p.away?.coverUserId ?? ""}>
                  <option value="">{AWAY_WORDS.nobody}</option>
                  {coverChoices
                    .filter((c) => c.id !== p.userId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={btnPrimary}>
                  {AWAY_WORDS.save}
                </button>
              </div>
            </ActionForm>
            {p.away ? (
              <ActionButton action={clearAwayAction} fields={{ userId: p.userId }} label={AWAY_WORDS.clear} className={btnQuiet} formClassName="mt-2" closeSheetOnOk={false} />
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
