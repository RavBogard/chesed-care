"use client";

import { createTaskAction, updateTaskAction } from "@/app/volunteers-actions";
import { ActionForm } from "@/components/action-form";
import { UseAddressButton } from "@/components/use-address-button";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { SERIES_LABELS, WEEKDAYS } from "@/lib/roster-wording";
import { KIND_ORDER, KIND_WORDS, NEEDED_HELP, QUICK_STARTS, QUICK_STARTS_LABEL, type KindKey } from "@/lib/volunteers-wording";

export type TaskValues = { kind: KindKey; forLabel: string; needed: string; date: string; timeWindow: string; place: string; peopleNeeded: string; contactLine: string };
export const EMPTY_TASK: TaskValues = { kind: "visit", forLabel: "", needed: "", date: "", timeWindow: "", place: "", peopleNeeded: "", contactLine: "" };

/**
 * The words of a task, as volunteers will read them. Everything here is shown on the public link
 * (the place only after someone signs up): the hints say so, and say what not to write.
 */
export function TaskForm({ values, today, taskId, careItemId, addressSuggestion = null }: { values: TaskValues; today: string; taskId?: string; careItemId?: string; addressSuggestion?: string | null }) {
  const editing = taskId !== undefined;
  return (
    <ActionForm action={editing ? updateTaskAction : createTaskAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
      {editing ? null : <QuickStarts />}
      {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
      {careItemId ? <input type="hidden" name="careItemId" value={careItemId} /> : null}
      <div>
        <label htmlFor="t-kind" className={labelClass}>
          What kind of help
        </label>
        <select id="t-kind" name="kind" defaultValue={values.kind} className={inputClass}>
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {KIND_WORDS[k]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="t-for" className={labelClass}>
          Who it is for
        </label>
        <input id="t-for" name="forLabel" required maxLength={80} defaultValue={values.forLabel} className={inputClass} aria-describedby="t-for-help" />
        <p id="t-for-help" className="mt-1 text-sm text-rubric">
          A first name or a short label, like &ldquo;Ruth&rdquo; or &ldquo;the Cohen family&rdquo;. Everyone with the link reads it.
        </p>
      </div>
      <div>
        <label htmlFor="t-needed" className={labelClass}>
          What is needed
        </label>
        <textarea id="t-needed" name="needed" required rows={3} maxLength={300} defaultValue={values.needed} className={`${inputClass} py-2`} aria-describedby="t-needed-help" />
        <p id="t-needed-help" className="mt-1 text-sm text-rubric">
          {NEEDED_HELP}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="t-date" className={labelClass}>
            Date
          </label>
          <input id="t-date" name="date" type="date" required min={editing ? undefined : today} defaultValue={values.date} className={inputClass} />
        </div>
        <div>
          <label htmlFor="t-window" className={labelClass}>
            Time (optional)
          </label>
          <input id="t-window" name="timeWindow" maxLength={60} defaultValue={values.timeWindow} placeholder="2 to 4 pm" className={inputClass} />
        </div>
      </div>
      <div>
        <label htmlFor="t-place" className={labelClass}>
          Where (optional)
        </label>
        <UseAddressButton targetId="t-place" address={addressSuggestion} />
        <textarea id="t-place" name="place" rows={2} maxLength={300} defaultValue={values.place} className={`${inputClass} py-2`} aria-describedby="t-place-help" />
        <p id="t-place-help" className="mt-1 text-sm text-rubric">
          Shown only to someone once they have signed up.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="t-people" className={labelClass}>
            How many people
          </label>
          <input id="t-people" name="peopleNeeded" type="number" inputMode="numeric" min={1} max={50} defaultValue={values.peopleNeeded} placeholder="1" className={inputClass} aria-describedby="t-people-help" />
          <p id="t-people-help" className="mt-1 text-sm text-rubric">
            Leave empty for 1, or 10 for a shiva minyan.
          </p>
        </div>
        <div>
          <label htmlFor="t-contact" className={labelClass}>
            Who to ask with questions (optional)
          </label>
          <input id="t-contact" name="contactLine" maxLength={120} defaultValue={values.contactLine} className={inputClass} aria-describedby="t-contact-help" />
          <p id="t-contact-help" className="mt-1 text-sm text-rubric">
            Shown after someone signs up. Your choice whether to give one.
          </p>
        </div>
      </div>
      {editing ? null : <RepeatFields />}
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        {editing ? "Save changes" : "Post the task"}
      </button>
    </ActionForm>
  );
}

/** Optional, folded away: a task that repeats makes one ordinary task for each date, each with its own link (never more than 26). */
function RepeatFields() {
  return (
    <details className="rounded-md border border-rule bg-surface p-3" data-testid="repeat-fields">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-action underline underline-offset-4">Repeat this task</summary>
      <div className="mt-3 flex flex-col gap-4">
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{SERIES_LABELS.repeat}</legend>
          {(
            [
              ["", SERIES_LABELS.none],
              ["weekly", SERIES_LABELS.weekly],
              ["biweekly", SERIES_LABELS.biweekly],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className={checkRow}>
              <input type="radio" name="repeat" value={v} defaultChecked={v === ""} className={checkBox} />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{SERIES_LABELS.days}</legend>
          {WEEKDAYS.map((d, i) => (
            <label key={d} className={checkRow}>
              <input type="checkbox" name="weekdays" value={i} className={checkBox} />
              {d}
            </label>
          ))}
          <p className="mt-1 text-sm text-rubric">The first date above is the first time it happens, if it falls on one of these days.</p>
        </fieldset>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{SERIES_LABELS.end}</legend>
          <label className={checkRow}>
            <input type="radio" name="end" value="count" defaultChecked className={checkBox} />
            {SERIES_LABELS.count}
          </label>
          <div className="mb-2 ml-8">
            <label htmlFor="t-times" className={labelClass}>
              {SERIES_LABELS.times}
            </label>
            <input id="t-times" name="times" type="number" inputMode="numeric" min={1} max={26} defaultValue={4} className={inputClass} />
          </div>
          <label className={checkRow}>
            <input type="radio" name="end" value="until" className={checkBox} />
            {SERIES_LABELS.until}
          </label>
          <div className="ml-8">
            <label htmlFor="t-until" className={labelClass}>
              {SERIES_LABELS.untilDate}
            </label>
            <input id="t-until" name="until" type="date" className={inputClass} />
          </div>
        </fieldset>
      </div>
    </details>
  );
}

/** A row of buttons that fill the form below (no navigation). They set the kind, the people needed and, where there is one, the words; nothing is locked. */
function QuickStarts() {
  const fill = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.value = value;
  };
  return (
    <div data-testid="quick-starts">
      <p className={labelClass}>{QUICK_STARTS_LABEL}</p>
      <div className="flex flex-wrap gap-2">
        {QUICK_STARTS.map((q) => (
          <button
            key={q.key}
            type="button"
            className={btnQuiet}
            onClick={() => {
              fill("t-kind", q.kind);
              fill("t-people", String(q.peopleNeeded));
              if (q.needed) fill("t-needed", q.needed);
            }}
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}
