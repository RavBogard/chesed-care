import Link from "next/link";
import { Section } from "@/components/section";
import { btnQuiet, nameClass, tagQuiet } from "@/components/ui";
import { monthDay } from "@/lib/format";
import { canManageMealPages, canSeeMealsLine, type Actor } from "@/server/access/policy";
import { getDb } from "@/server/db/client";
import { mealsLineForPerson, type MealsLine } from "@/server/meals/person-line";
import { soft } from "@/server/soft";

const STATUS = { draft: "Draft", live: "Live", paused: "Paused", ended: "Ended" } as const;

function words(l: MealsLine): string {
  if (l.status === "draft") return "Not yet live";
  if (l.openDates === 0) return l.coveredThrough ? `Meals covered through ${monthDay(l.coveredThrough)}` : "No nights left";
  const open = l.openDates === 1 ? "1 open night" : `${l.openDates} open nights`;
  return l.coveredThrough ? `Covered through ${monthDay(l.coveredThrough)}, ${open}` : open;
}

/**
 * The meals line of a person, for the roles that may see it: each page about them with its
 * status and how far it is covered. Null when the role may not see it or it could not be
 * read (a failure must not break the person's page).
 */
export async function loadMealsLine(actor: Actor, person: { sfContactId?: string; sfAccountId?: string | null; outsidePersonId?: string }): Promise<MealsLine[] | null> {
  if (!canSeeMealsLine(actor)) return null;
  return soft("Meals line unavailable", null, () => mealsLineForPerson(getDb(), actor, person));
}

/** The line itself, and a way to start a page for those who may. */
export function PersonMeals({ actor, lines, startHref }: { actor: Actor; lines: MealsLine[] | null; startHref: string }) {
  if (lines === null) return null;
  const start = canManageMealPages(actor);
  if (lines.length === 0 && !start) return null;
  return (
    <Section title="Mitzvah Meals">
      {lines.length ? (
        <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="meals-line">
          {lines.map((l) => (
            <li key={l.pageId}>
              <Link href={`/meals/${l.pageId}`} className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 transition-colors hover:bg-tint focus-visible:-outline-offset-3">
                <span className={`${nameClass} min-w-0 break-words underline decoration-control underline-offset-4`}>{l.title}</span>
                <span className={tagQuiet}>{STATUS[l.status]}</span>
                <span className="w-full text-sm text-rubric">{words(l)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-rubric">No meals page yet.</p>
      )}
      {start ? (
        <p className="mt-3">
          <Link href={startHref} className={btnQuiet}>
            Start a Mitzvah Meals page
          </Link>
        </p>
      ) : null}
    </Section>
  );
}
