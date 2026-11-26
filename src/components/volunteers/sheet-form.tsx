"use client";

import { useState } from "react";
import { createSheetAction } from "@/app/volunteers-actions";
import { ActionForm } from "@/components/action-form";
import { NEEDED_HELP } from "@/lib/volunteers-wording";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass } from "@/components/ui";

/** A shiva sheet: the family, the place, and the evenings (each a minyan slot counting toward ten). */
export function SheetForm({ today, careItemId }: { today: string; careItemId?: string }) {
  const [rows, setRows] = useState([0, 1, 2]);
  return (
    <ActionForm action={createSheetAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
      {careItemId ? <input type="hidden" name="careItemId" value={careItemId} /> : null}
      <div>
        <label htmlFor="s-title" className={labelClass}>
          Who the shiva is for
        </label>
        <input id="s-title" name="title" required maxLength={80} className={inputClass} aria-describedby="s-title-help" />
        <p id="s-title-help" className="mt-1 text-sm text-rubric">
          A short label like &ldquo;the Cohen family&rdquo;. Everyone with the link reads it.
        </p>
      </div>
      <div>
        <label htmlFor="s-needed" className={labelClass}>
          A line for volunteers (optional)
        </label>
        <textarea id="s-needed" name="needed" rows={2} maxLength={300} className={`${inputClass} py-2`} aria-describedby="s-needed-help" />
        <p id="s-needed-help" className="mt-1 text-sm text-rubric">
          {NEEDED_HELP}
        </p>
      </div>
      <div>
        <label htmlFor="s-place" className={labelClass}>
          Where (optional)
        </label>
        <textarea id="s-place" name="place" rows={2} maxLength={300} className={`${inputClass} py-2`} aria-describedby="s-place-help" />
        <p id="s-place-help" className="mt-1 text-sm text-rubric">
          Shown only to someone once they have signed up for an evening.
        </p>
      </div>
      <div>
        <label htmlFor="s-contact" className={labelClass}>
          Who to ask with questions (optional)
        </label>
        <input id="s-contact" name="contactLine" maxLength={120} className={inputClass} />
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">The evenings</legend>
        {rows.map((r, i) => (
          <div key={r} className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`s-date-${r}`} className={labelClass}>
                Evening {i + 1}
              </label>
              <input id={`s-date-${r}`} name="date" type="date" min={today} required={i === 0} className={inputClass} />
            </div>
            <div>
              <label htmlFor={`s-window-${r}`} className={labelClass}>
                Time (optional)
              </label>
              <input id={`s-window-${r}`} name="window" maxLength={60} placeholder="7 pm" className={inputClass} />
            </div>
          </div>
        ))}
        {rows.length < 14 ? (
          <button type="button" className={`${btnQuiet} self-start`} onClick={() => setRows((x) => [...x, Math.max(...x) + 1])}>
            Add another evening
          </button>
        ) : null}
      </fieldset>
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        Post the sheet
      </button>
    </ActionForm>
  );
}
