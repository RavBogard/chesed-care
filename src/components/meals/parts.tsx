import { Hebrew } from "@/components/hebrew";
import { facingLine, noticeClass, tagQuiet, titleClass } from "@/components/ui";
import { longDate } from "@/lib/format";
import { FOOD_TYPE_WORDS, KASHRUT_WORDS, mealWord, type FoodType, type Kashrut } from "@/lib/meals-wording";
import type { CalendarNote } from "@/server/meals/calendar-notes";

/** "Dinner on Tuesday, December 1". */
export const nightLabel = (date: string, meal: "dinner" | "lunch") => `${mealWord(meal)} on ${longDate(date)}`;

/** The congregation's name at the head of every public page: a navy bar, as on the signed-in screens, with no menu and no links. */
export function PublicFrame({ congregation, title, children, wide = false }: { congregation: string; title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-shell text-on-shell print:bg-transparent print:text-ink">
        <div className={`mx-auto flex min-h-14 w-full ${wide ? "max-w-xl lg:max-w-3xl" : "max-w-xl lg:max-w-3xl"} items-center px-4 py-2 lg:px-8`}>
          <p className="font-serif text-xl font-bold leading-tight">{congregation}</p>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-xl px-4 pb-16 pt-6 lg:max-w-3xl lg:px-8 lg:pt-10">
        <h1 className="break-words font-serif text-[1.625rem] font-bold leading-tight text-balance lg:text-4xl">{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** A section of a public page: its heading and its body, set apart by space and a hairline rule above, never a card in a card. */
export function PageSection({ id, heading, children }: { id?: string; heading: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className="mt-8 border-t border-rule pt-6">
      <h2 id={id ? `${id}-h` : undefined} className={`${titleClass} text-xl`}>
        {heading}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export const notesByDate = (notes: CalendarNote[]) => new Map(notes.map((n) => [n.date, n]));

/** "Shabbat", "Erev Pesach", or both, as the line under a date. Candle-lighting only when `candles` (the organiser's). */
export function dayNote(note: CalendarNote | undefined, candles = false): string | null {
  if (!note) return null;
  const parts = [note.shabbat ? "Shabbat" : null, note.holiday, candles && note.candleLighting ? `Candle lighting ${note.candleLighting}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The date of a night, the Hebrew date facing it on the same line. */
export function DateHead({ date, meal, note, candles = false }: { date: string; meal: "dinner" | "lunch"; note?: CalendarNote; candles?: boolean }) {
  const extra = dayNote(note, candles);
  return (
    <div>
      <div className={facingLine}>
        <h3 className="min-w-0 font-serif text-lg font-bold leading-snug">
          <span className="sr-only">{mealWord(meal)}, </span>
          {longDate(date)}
          {meal === "lunch" ? <span className="font-sans text-sm font-semibold text-rubric"> · Lunch</span> : null}
        </h3>
        {note?.hebrewDate ? (
          <Hebrew size="text-lg" className="text-action">
            {note.hebrewDate}
          </Hebrew>
        ) : null}
      </div>
      {extra ? <p className="text-sm text-rubric">{extra}</p> : null}
    </div>
  );
}

/** A helper's food: "Dairy" as a small tag, so nobody brings the same dish twice. */
export function FoodTag({ foodType }: { foodType: string | null }) {
  if (!foodType || foodType === "not_sure") return null;
  return <span className={tagQuiet}>{FOOD_TYPE_WORDS[foodType as FoodType] ?? foodType}</span>;
}

export type Facts = {
  foodFor: string | null;
  kashrut: Kashrut;
  dietary: string[];
  allergies: string | null;
  dropOffWindow: string | null;
};

/**
 * What to know before you cook. Allergies come first and apart from preferences, in the
 * amber notice colour, because they are the line that matters most.
 */
export function FoodFacts({ facts, headingLevel = "h3" }: { facts: Facts; headingLevel?: "h3" | "h2" }) {
  const Sub = headingLevel;
  return (
    <div className="flex flex-col gap-4">
      <div className={noticeClass} data-testid="allergies">
        <Sub className="text-base font-bold">Allergies</Sub>
        <p className="mt-0.5 whitespace-pre-line text-base">{facts.allergies ?? "None have been listed."}</p>
      </div>
      <dl className="flex flex-col gap-3 text-base">
        <Fact label="Who is eating" value={facts.foodFor} />
        <Fact label="Kosher" value={KASHRUT_WORDS[facts.kashrut]} />
        {facts.dietary.length ? (
          <div>
            <dt className="text-sm font-semibold">Preferences</dt>
            <dd className="mt-1">
              <ul className="flex flex-wrap gap-1.5" aria-label="Preferences">
                {facts.dietary.map((d) => (
                  <li key={d} className={tagQuiet}>
                    {d}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <Fact label="Drop-off" value={facts.dropOffWindow} />
      </dl>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-sm font-semibold">{label}</dt>
      <dd className="whitespace-pre-line break-words">{value}</dd>
    </div>
  );
}
