"use client";

import { useState } from "react";
import { saveTodayPrefsAction } from "@/app/today-actions";
import { kindWord } from "@/server/lifecycle/cards";
import type { OccasionType } from "@/server/lifecycle/types";
import { btnQuiet, btnSelected } from "./ui";
import { CheckIcon } from "./check-icon";

type Saved = { kind: OccasionType | null; hideBirthdays: boolean };

const check = <CheckIcon />;

/**
 * Filters for the dates on Today: one kind at a time, and "Hide birthdays". The cards are
 * drawn on the server whatever is chosen; the choice only hides them (see globals.css, on
 * data-date-kind and data-hide-birthdays), so the page is complete without scripts. The
 * choice is the person's own: it arrives from their saved choice (so the first paint is
 * already right) and is saved to it again at each change, so it follows them to any device.
 */
export function DateFilters({ kinds, initial, children }: { kinds: OccasionType[]; initial: Saved; children: React.ReactNode }) {
  const [state, setState] = useState<Saved>(initial);
  const set = (next: Saved) => {
    setState(next);
    // A save that fails leaves the choice for this visit only.
    void saveTodayPrefsAction(next.kind, next.hideBirthdays).catch(() => undefined);
  };
  if (kinds.length === 0) return <>{children}</>;
  return (
    <div data-date-kind={state.kind ?? undefined} data-hide-birthdays={state.hideBirthdays ? "true" : undefined}>
      <div role="group" aria-label="Show dates" className="mb-5 mt-8 flex flex-wrap gap-2" data-testid="date-filters">
        <button type="button" aria-pressed={state.kind === null} className={state.kind === null ? `${btnSelected} gap-1.5` : btnQuiet} onClick={() => set({ ...state, kind: null })}>
          {state.kind === null ? check : null}All kinds
        </button>
        {kinds.map((k) => (
          <button key={k} type="button" aria-pressed={state.kind === k} className={state.kind === k ? `${btnSelected} gap-1.5` : btnQuiet} onClick={() => set({ ...state, kind: k })}>
            {state.kind === k ? check : null}
            {kindWord(k)}
          </button>
        ))}
        {kinds.includes("birthday") ? (
          <button type="button" aria-pressed={state.hideBirthdays} className={state.hideBirthdays ? `${btnSelected} gap-1.5` : btnQuiet} onClick={() => set({ ...state, hideBirthdays: !state.hideBirthdays })}>
            {state.hideBirthdays ? check : null}
            Hide birthdays
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}
