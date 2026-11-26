import { markKey } from "@/server/care/occasion-marks";
import { byKind, sortByKind, toCards, type OccasionCard } from "@/server/lifecycle/cards";
import type { Occasion } from "@/server/lifecycle/types";
import { KindIcon } from "./kind-tag";
import { OccasionCardView } from "./occasion-row";
import { kindText } from "./ui";

export function isDone(marks: ReadonlySet<string>, o: Occasion): boolean {
  return marks.has(markKey({ occasionType: o.type, subjectId: o.subjectId, sfAccountId: o.accountId ?? "", year: Number(o.date.slice(0, 4)) }));
}

/**
 * The cards for one group of dates (a day, or the households in shloshim), which the caller
 * heads with an h2. A yahrzeit or a shloshim is one card for each mourner. Cards still to do come first, gathered by kind in a fixed order (yahrzeit,
 * shloshim, birthday, anniversary), each kind under its own h3 with a count; a kind with no
 * cards has no heading. `grouped={false}` is for a group that is one kind already: no kind
 * headings, and the cards are titled at h3. Rows marked done move into a closed group beneath,
 * at full contrast and in the same order of kinds, where they can be undone.
 */
export function OccasionList({ items, today, marks, drafts, doneLabel, grouped = true }: { items: Occasion[]; today: string; marks: ReadonlySet<string>; drafts: Partial<Record<Occasion["type"], string>>; doneLabel: string; grouped?: boolean }) {
  const done = (o: Occasion) => isDone(marks, o);
  const open = sortByKind(toCards(items.filter((o) => !done(o))));
  const closed = sortByKind(toCards(items.filter(done)));
  const count = items.filter(done).length;
  const cards = (list: OccasionCard[], level: 3 | 4) => list.map((card) => <OccasionCardView key={card.key} card={card} today={today} isDone={done} drafts={drafts} level={level} />);
  return (
    <>
      {grouped ? (
        byKind(open).map((group) => (
          <section key={group.type} className="mt-4" data-testid="kind-group" data-occasion-type={group.type}>
            <h3 className={`flex items-center gap-1.5 text-xs font-bold tracking-[0.09em] uppercase ${kindText[group.type]}`}>
              <KindIcon type={group.type} />
              <span>
                {group.heading} <span className="tabular-nums">· {group.cards.length}</span>
              </span>
            </h3>
            <ul className="mt-2 flex flex-col gap-3">{cards(group.cards, 4)}</ul>
          </section>
        ))
      ) : open.length ? (
        <ul className="mt-2 flex flex-col gap-3">{cards(open, 3)}</ul>
      ) : null}
      {closed.length ? (
        <details className="mt-3" data-testid="done-group">
          <summary className="cursor-pointer rounded-md px-1 py-3 text-sm font-semibold text-rubric hover:text-ink">
            <h3 className="inline">
              {doneLabel} ({count})
            </h3>
          </summary>
          <ul className="mt-1 flex flex-col gap-3">{cards(closed, 4)}</ul>
        </details>
      ) : null}
    </>
  );
}
