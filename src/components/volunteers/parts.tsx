import { longDate } from "@/lib/format";
import { KIND_WORDS, placesWords, type KindKey } from "@/lib/volunteers-wording";

/** "Visit for Ruth": the heading of a task, in the poster's own label. */
export const taskHeading = (kind: KindKey, forLabel: string) => `${KIND_WORDS[kind]} for ${forLabel}`;

/** The date, and the time window after it when there is one. */
export const whenWords = (date: string, timeWindow: string | null) => (timeWindow ? `${longDate(date)}, ${timeWindow}` : longDate(date));

/** A term and its answer, the plain way to say a fact on a phone. */
export function Facts({ rows }: { rows: { term: string; text: string }[] }) {
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-3 text-base sm:grid-cols-[8rem_minmax(0,1fr)]">
      {rows.map((r) => (
        <div key={r.term} className="contents">
          <dt className="font-semibold">{r.term}</dt>
          <dd className="whitespace-pre-line break-words">{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

export const places = placesWords;
