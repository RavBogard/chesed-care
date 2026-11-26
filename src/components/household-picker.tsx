"use client";

import { startTransition, useActionState, useState } from "react";
import { searchHouseholdsAction, type HouseholdSearch } from "@/app/meals-actions";
import { btnPrimary, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass, noticeClass } from "@/components/ui";

/** Choose a member by name: the name-only search (no phone, no address, no care record), then one radio per person. Posts `contactId`. */
export function HouseholdPicker({ legend, idPrefix, onPick }: { legend: string; idPrefix: string; onPick?: (name: string) => void }) {
  const [state, dispatch, pending] = useActionState<HouseholdSearch, FormData>(searchHouseholdsAction, { status: "idle" });
  const [q, setQ] = useState("");
  const search = () => {
    if (pending || q.trim().length < 2) return;
    const data = new FormData();
    data.set("q", q);
    startTransition(() => dispatch(data));
  };
  return (
    <fieldset className={fieldsetClass}>
      <legend className={legendClass}>{legend}</legend>
      <label htmlFor={`${idPrefix}-q`} className={labelClass}>
        Name or household
      </label>
      <div className="flex gap-2">
        <input
          id={`${idPrefix}-q`}
          type="search"
          autoComplete="off"
          maxLength={60}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search();
            }
          }}
          className={inputClass}
        />
        <button type="button" className={btnPrimary} onClick={search} aria-disabled={pending}>
          Find
        </button>
      </div>
      <div role="status" aria-live="polite" className="mt-2">
        {pending ? <p className="text-sm text-rubric">Searching&hellip;</p> : null}
        {!pending && state.status === "error" ? <p className={noticeClass}>{state.message}</p> : null}
        {!pending && state.status === "results" && state.results.length === 0 ? <p className="text-sm text-rubric">No one found. Try fewer letters or just a last name.</p> : null}
      </div>
      {state.status === "results" && state.results.length ? (
        <ul className="mt-1 divide-y divide-rule-soft">
          {state.results.map((r) => (
            <li key={r.contactId}>
              <label className={`${checkRow} items-start py-2`}>
                <input type="radio" name="contactId" value={r.contactId} required className={`${checkBox} mt-0.5`} onChange={() => onPick?.(r.name)} />
                <span className="min-w-0">
                  <span className="block font-semibold">{r.name}</span>
                  {r.household && r.household !== r.name ? <span className="block text-sm text-rubric">{r.household}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
