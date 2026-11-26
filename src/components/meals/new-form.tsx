"use client";

import { useState } from "react";
import { createMealsPageAction } from "@/app/meals-actions";
import { ActionForm } from "@/components/action-form";
import { HouseholdPicker } from "@/components/household-picker";
import { btnLaptopNatural, btnPrimary, checkBox, checkRow, inputClass, labelClass } from "@/components/ui";
import { familyTitle } from "@/lib/meals-wording";
import { DateGrid, type DayNote, type Month } from "./date-grid";

export type Preset = { field: "careItemId" | "outsidePersonId" | "contactId"; id: string; name: string } | null;

/** Set up a page: the household, the dates and the family's yes. Nothing else is asked. */
export function NewMealsForm({ preset, today, months, notes, suggested }: { preset: Preset; today: string; months: Month[]; notes: Record<string, DayNote>; suggested: string[] }) {
  const [title, setTitle] = useState(preset ? familyTitle(preset.name) : "");
  return (
    <ActionForm action={createMealsPageAction} className="flex flex-col gap-6" closeSheetOnOk={false}>
      {preset ? (
        <>
          <input type="hidden" name={preset.field} value={preset.id} />
          <p className="text-base">
            For <strong>{preset.name}</strong>.
          </p>
        </>
      ) : (
        <HouseholdPicker legend="Which household?" idPrefix="mm" onPick={(name) => setTitle(familyTitle(name))} />
      )}
      <div>
        <label htmlFor="mm-title" className={labelClass}>
          Name on the page
        </label>
        <input id="mm-title" name="title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} aria-describedby="mm-title-help" />
        <p id="mm-title-help" className="mt-1 text-sm text-rubric">
          The page will read &ldquo;Mitzvah Meals for {title || "the … family"}&rdquo;. It never says why.
        </p>
      </div>
      <section aria-labelledby="mm-dates">
        <h2 id="mm-dates" className="mb-2 font-serif text-xl font-bold">
          Which nights?
        </h2>
        <DateGrid today={today} months={months} notes={notes} suggested={suggested} initial={suggested} />
      </section>
      <label className={`${checkRow} items-start`}>
        <input type="checkbox" name="agreed" className={`${checkBox} mt-0.5`} />
        The family has said yes to this page
      </label>
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        Make the page
      </button>
    </ActionForm>
  );
}
