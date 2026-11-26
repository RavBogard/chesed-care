"use client";

import { useMemo, useState } from "react";
import { Hebrew } from "@/components/hebrew";
import { btnQuiet } from "@/components/ui";
import { longDate } from "@/lib/format";

export type Month = { key: string; label: string; /** Empty cells before the 1st (Sunday first). */ lead: number; days: string[] };
export type DayNote = { hebrew: string | null; shabbat: boolean; holiday: string | null; candle: string | null };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const noteWords = (n: DayNote | undefined) => [n?.shabbat ? "Shabbat" : null, n?.holiday ?? null, n?.candle ? `candle lighting ${n.candle}` : null].filter(Boolean).join(", ");

/**
 * Dates on a month grid. The suggested every-other-night rhythm is chosen at the start;
 * a tap adds or removes a day. Shabbat and holidays are marked, never blocked: a dot on
 * the day, their words and the candle-lighting time in the list of chosen nights beneath.
 * Each chosen date is posted as a hidden `date` field.
 */
export function DateGrid({ today, months, notes, suggested, initial }: { today: string; months: Month[]; notes: Record<string, DayNote>; suggested: string[]; initial: string[] }) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initial));
  const sorted = useMemo(() => [...chosen].sort(), [chosen]);
  const toggle = (d: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {suggested.length ? (
          <button type="button" className={btnQuiet} onClick={() => setChosen(new Set(suggested))}>
            Every other night, 3 weeks
          </button>
        ) : null}
        <button type="button" className={btnQuiet} onClick={() => setChosen(new Set())}>
          Clear all
        </button>
      </div>
      <p className="flex items-center gap-2 text-sm text-rubric">
        <span aria-hidden="true" className="size-2 rounded-full bg-rubric" />A dot marks Shabbat and holidays. They can be chosen like any other day.
      </p>
      {months.map((m) => (
        <div key={m.key}>
          <h3 className="font-serif text-lg font-bold">{m.label}</h3>
          <div className="mt-2 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((w) => (
              <div key={w} aria-hidden="true" className="py-1 text-center text-xs font-bold text-rubric">
                {w}
              </div>
            ))}
            {Array.from({ length: m.lead }, (_, i) => (
              <div key={`b${i}`} aria-hidden="true" />
            ))}
            {m.days.map((d) => {
              const n = notes[d];
              const past = d < today;
              const on = chosen.has(d);
              const marked = !!(n?.shabbat || n?.holiday);
              return (
                <div key={d}>
                  <button
                    type="button"
                    disabled={past}
                    aria-pressed={on}
                    aria-label={`${longDate(d)}${noteWords(n) ? `, ${noteWords(n)}` : ""}`}
                    onClick={() => toggle(d)}
                    className={`relative flex min-h-11 w-full flex-col items-center justify-center rounded-md text-base tabular-nums disabled:text-rubric disabled:opacity-50 ${on ? "border-2 border-action bg-selected font-bold text-action" : "border border-control bg-surface text-ink hover:bg-tint"}`}
                  >
                    {Number(d.slice(8))}
                    {marked ? <span aria-hidden="true" className="absolute bottom-1 size-1.5 rounded-full bg-rubric" /> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div>
        <h3 className="font-serif text-lg font-bold" id="chosen-nights">
          {sorted.length === 1 ? "1 night chosen" : `${sorted.length} nights chosen`}
        </h3>
        {sorted.length === 0 ? (
          <p className="mt-1 text-sm text-rubric">Tap the days you would like covered.</p>
        ) : (
          <ul aria-labelledby="chosen-nights" className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface">
            {sorted.map((d) => (
              <li key={d} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2">
                <span className="min-w-0">
                  <span className="font-semibold">{longDate(d)}</span>
                  {noteWords(notes[d]) ? <span className="block text-sm text-rubric first-letter:uppercase">{noteWords(notes[d])}</span> : null}
                </span>
                {notes[d]?.hebrew ? <Hebrew size="text-lg" className="text-action">{notes[d].hebrew!}</Hebrew> : null}
                <input type="hidden" name="date" value={d} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
