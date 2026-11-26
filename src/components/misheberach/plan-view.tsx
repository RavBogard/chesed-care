import { BARRED_HELP, BARRED_NOTICE, LEFT_ALONE_KIND, LEFT_ALONE_TITLE, LEFT_ALONE_WHY, PLAN_NOTHING, PLAN_TITLE } from "@/lib/misheberach-wording";
import type { Plan } from "@/server/misheberach/merge";
import { RemoveBarred } from "./entry-forms";
import { Section } from "../section";
import { tagQuiet } from "../ui";

const Group = ({ title, items }: { title: string; items: React.ReactNode[] }) =>
  items.length === 0 ? null : (
    <div className="mt-3">
      <h3 className="text-sm font-semibold">
        {title} ({items.length})
      </h3>
      <ul className="mt-1 flex flex-col gap-1 text-base">
        {items.map((item, i) => (
          <li key={i} className="min-w-0 break-words" dir="auto">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );

/** What the sync would do (trial mode), or would have done (a stopped run): lines to add, change and remove, entries to add and end, and lines left alone. Clergy and owner only: it has names in it. */
export function PlanView({ plan }: { plan: Plan }) {
  const none = plan.addLines.length + plan.changeLines.length + plan.removeLines.length + plan.addEntries.length + plan.endEntries.length + plan.leftAlone.length === 0;
  return (
    <Section title={PLAN_TITLE}>
      <div data-testid="mi-plan">
        {none ? <p className="mt-2 text-base text-rubric">{PLAN_NOTHING}</p> : null}
        <Group title="Lines it would add to the packet" items={plan.addLines} />
        <Group title="Lines it would change in the packet" items={plan.changeLines.map((c) => `${c.from}  to  ${c.to}`)} />
        <Group title="Lines it would remove from the packet" items={plan.removeLines} />
        <Group title="Names it would add to the list" items={plan.addEntries} />
        <Group title="Names it would take off the list" items={plan.endEntries} />
        <Group
          title="Lines it leaves alone"
          items={plan.leftAlone.map((l, i) => (
            <span key={i}>
              {l.text} <span className={tagQuiet}>{LEFT_ALONE_WHY[l.why]}</span>
            </span>
          ))}
        />
      </div>
    </Section>
  );
}

/**
 * The standing notice: lines the sync is leaving alone, by kind. A line of someone who asked not to be
 * listed comes first and loudest: it is still in the packet and would be read aloud, and one tap takes it
 * out (a real sync only). The line text is shown here to clergy and owner, on their own list page.
 */
export function LeftAloneNotice({ plan, counts, canRemove }: { plan: Plan; counts: Record<string, number> | null; canRemove: boolean }) {
  const of = (why: Plan["leftAlone"][number]["why"]) => plan.leftAlone.filter((l) => l.why === why).map((l) => l.text);
  const total = (why: Plan["leftAlone"][number]["why"], key: string) => Math.max(counts?.[key] ?? 0, of(why).length);
  const barred = of("asked_not_listed");
  const others = (["unreadable", "duplicate", "ended_in_app"] as const).map((why) => ({ why, lines: of(why), n: total(why, why === "unreadable" ? "leftAlone" : why === "duplicate" ? "duplicates" : "stillInPacket") })).filter((k) => k.lines.length > 0);
  if (barred.length === 0 && others.length === 0) return null;
  return (
    <section aria-label={LEFT_ALONE_TITLE} className="mb-5 flex flex-col gap-3" data-testid="mi-left-alone">
      {barred.length > 0 ? (
        <div className="rounded-md border-2 border-alert bg-alert-band p-3 text-alert" data-testid="mi-left-alone-barred">
          <p className="font-bold">
            {BARRED_NOTICE} ({total("asked_not_listed", "blocked")})
          </p>
          <p className="mt-1 text-sm">{BARRED_HELP}</p>
          <ul className="mt-2 flex flex-col gap-1 text-base text-ink">
            {barred.map((t, i) => (
              <li key={i} dir="auto" className="break-words">
                {t}
              </li>
            ))}
          </ul>
          {canRemove ? (
            <div className="mt-3">
              <RemoveBarred />
            </div>
          ) : null}
        </div>
      ) : null}
      {others.map((k) => (
        <div key={k.why} className="rounded-md bg-alert-band p-3 text-sm text-alert" data-testid={`mi-left-alone-${k.why}`}>
          <p className="font-semibold">
            {LEFT_ALONE_KIND[k.why]} ({k.n})
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-base text-ink">
            {k.lines.map((t, i) => (
              <li key={i} dir="auto" className="break-words">
                {t}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
