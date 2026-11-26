import { kindWord } from "@/server/lifecycle/cards";
import type { OccasionType } from "@/server/lifecycle/types";
import { kindFill } from "./ui";

/** One drawn mark per kind, in a single line weight: a candle flame, a memorial lamp, a balloon, two rings. */
const PATHS: Record<OccasionType, React.ReactNode> = {
  yahrzeit: (
    <>
      <path d="M12 2.5c2.4 2.6 3.8 4.6 3.8 6.7a3.8 3.8 0 0 1-7.6 0c0-2.1 1.4-4.1 3.8-6.7Z" />
      <path d="M9 16h6v5.5H9z" />
    </>
  ),
  shloshim: (
    <>
      <path d="M12 2.5c1.3 1.5 2 2.5 2 3.6a2 2 0 0 1-4 0c0-1.1.7-2.1 2-3.6Z" />
      <path d="M4.5 11h15a7.5 7.5 0 0 1-15 0Z" />
      <path d="M12 18.5v3M8.5 21.5h7" />
    </>
  ),
  birthday: (
    <>
      <ellipse cx="12" cy="8.5" rx="5.5" ry="6.5" />
      <path d="m10.5 16.5 1.5-1.5 1.5 1.5ZM12 16.5c0 2.5 2.5 2.5 1.5 5" />
    </>
  ),
  anniversary: (
    <>
      <circle cx="8.5" cy="12" r="5.5" />
      <circle cx="15.5" cy="12" r="5.5" />
    </>
  ),
};

export function KindIcon({ type, className = "" }: { type: OccasionType; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`size-4 shrink-0 ${className}`}>
      {PATHS[type]}
    </svg>
  );
}

/**
 * The kind of an occasion as a solid tag: its icon and its word in capitals, on the fill of
 * its kind. The same tag heads a card, counts a day ("3 yahrzeits") and labels a date on a
 * person's page. The capitals are set in CSS, so the word is read and copied as written.
 */
export function KindTag({ type, children }: { type: OccasionType; children?: React.ReactNode }) {
  return (
    <span className={`inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-sans text-xs leading-5 font-bold tracking-[0.06em] [overflow-wrap:anywhere] uppercase ${kindFill[type]}`} data-tone={type}>
      <KindIcon type={type} />
      {children ?? kindWord(type)}
    </span>
  );
}
