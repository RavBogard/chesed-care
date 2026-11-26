"use client";

import { staffAddCareAction, staffAddMiSheberachAction } from "@/app/staff-add-actions";
import { ActionForm } from "@/components/action-form";
import { HouseholdPicker } from "@/components/household-picker";
import { btnLaptopNatural, btnPrimary, checkBox, checkRow, inputClass, labelClass } from "@/components/ui";
import { CATEGORY_KEYS, CATEGORY_LABEL } from "@/lib/care-labels";
import { ADD_CARE_AWAY, ADD_CARE_HELP, ADD_CARE_SENSITIVE, ADD_CARE_SUBMIT, ADD_CARE_WORDS, ADD_CARE_WORDS_HELP, ADD_MI_HELP, ADD_MI_SUBMIT } from "@/lib/staff-add-wording";
import type { ClergyChoice } from "@/server/care/staff-add";

/** A member, a rabbi, a kind and a line or two: straight onto that rabbi's care list. */
export function AddToCareList({ clergy }: { clergy: ClergyChoice[] }) {
  return (
    <ActionForm action={staffAddCareAction} className="mt-2 flex flex-col gap-4">
      <p className="text-sm text-rubric">{ADD_CARE_HELP}</p>
      <HouseholdPicker legend="Who is it about?" idPrefix="sa" />
      <div>
        <label htmlFor="sa-owner" className={labelClass}>
          Whose care list?
        </label>
        <select id="sa-owner" name="ownerUserId" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Choose a rabbi
          </option>
          {clergy.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.away ? " (away)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="sa-category" className={labelClass}>
          What kind of care?
        </label>
        <select id="sa-category" name="category" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Choose one
          </option>
          {CATEGORY_KEYS.map((k) => (
            <option key={k} value={k}>
              {CATEGORY_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="sa-words" className={labelClass}>
          {ADD_CARE_WORDS}
        </label>
        <textarea id="sa-words" name="words" rows={3} required maxLength={500} className={`${inputClass} min-h-24 py-2`} aria-describedby="sa-words-help" />
        <p id="sa-words-help" className="mt-1 text-sm text-rubric">
          {ADD_CARE_WORDS_HELP}
        </p>
      </div>
      <div>
        <label className={checkRow}>
          <input type="checkbox" name="sensitive" className={checkBox} aria-describedby="sa-sensitive-help" />
          <span>{ADD_CARE_SENSITIVE}</span>
        </label>
        <p id="sa-sensitive-help" className="text-sm text-rubric">
          {ADD_CARE_AWAY}
        </p>
      </div>
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        {ADD_CARE_SUBMIT}
      </button>
    </ActionForm>
  );
}

/** A name as it is read aloud, and who asked. */
export function AddToMiSheberach() {
  return (
    <ActionForm action={staffAddMiSheberachAction} className="mt-2 flex flex-col gap-4">
      <p className="text-sm text-rubric">{ADD_MI_HELP}</p>
      <div>
        <label htmlFor="sm-name" className={labelClass}>
          Name to be read
        </label>
        <input id="sm-name" name="name" required maxLength={120} autoComplete="off" className={inputClass} />
      </div>
      <div>
        <label htmlFor="sm-asked" className={labelClass}>
          Who asked? (optional)
        </label>
        <input id="sm-asked" name="askedBy" maxLength={120} autoComplete="off" className={inputClass} />
      </div>
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        {ADD_MI_SUBMIT}
      </button>
    </ActionForm>
  );
}
