"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { previewJourneyAction } from "@/app/journey-actions";
import { shortDate } from "@/lib/format";
import type { JourneyPreview } from "@/server/journeys/journeys";
import { btnQuiet, checkBox, fieldsetClass, inputClass, labelClass, legendClass } from "./ui";

/** What the picker needs to know of each template, worked out on the server. */
export type JourneyOption = { key: string; name: string; anchorLabel: string; secondLabel: string | null; standing: boolean };

/**
 * Choose a journey and see its steps, with their dates, before anything is saved. Each step
 * can be unticked. The Mitzvah Corps steps say who will hold them. Used inside a form: the
 * start sheet on a care item, and the accept sheet in the Inbox (where "none" is allowed).
 * Fields: journeyKey, journeyAnchor, journeySecond, journeyInterval, journeyStep (each
 * ticked step), journeyLead, and journeyPreviewed once the steps are on screen.
 */
export function JourneyPicker({ options, today, initialKey = "", initialAnchor, optional = false, suggestedKey, idPrefix }: { options: JourneyOption[]; today: string; initialKey?: string; initialAnchor?: string; optional?: boolean; suggestedKey?: string; idPrefix: string }) {
  const [key, setKey] = useState(initialKey);
  const [anchor, setAnchor] = useState(initialAnchor ?? today);
  const [second, setSecond] = useState("");
  const [weeks, setWeeks] = useState("4");
  // The latest answer, with the choices it was worked out for: shown only while they are still the ones on screen.
  const [answer, setAnswer] = useState<{ for: string; preview: JourneyPreview | null; problem: string | null } | null>(null);
  const [pending, startTransition] = useTransition();
  const option = options.find((o) => o.key === key) ?? null;
  const stepsId = useId();
  const asked = key && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? JSON.stringify([key, anchor, second, option?.standing ? weeks : ""]) : null;

  useEffect(() => {
    if (!asked) return;
    let live = true;
    startTransition(async () => {
      const result = await previewJourneyAction({ templateKey: key, anchorDate: anchor, secondDate: second, intervalWeeks: option?.standing ? weeks : undefined });
      if (!live) return;
      setAnswer(result.status === "ok" ? { for: asked, preview: result.data, problem: null } : { for: asked, preview: null, problem: result.message });
    });
    return () => {
      live = false;
    };
    // `asked` holds every input the preview depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const current = asked && answer?.for === asked ? answer : null;
  const preview = current?.preview ?? null;
  const problem = current?.problem ?? null;
  const leadSteps = preview?.steps.some((s) => s.who === "lead") ?? false;
  const suggestion = !key && suggestedKey ? options.find((o) => o.key === suggestedKey) : undefined;
  return (
    <div className="flex flex-col gap-4" data-testid="journey-picker">
      <div>
        <label htmlFor={`${idPrefix}-journey`} className={labelClass}>
          {optional ? "Start a journey (optional)" : "Journey"}
        </label>
        <select id={`${idPrefix}-journey`} name="journeyKey" value={key} onChange={(e) => setKey(e.target.value)} required={!optional} className={inputClass}>
          <option value="">{optional ? "No journey" : "Choose a journey"}</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name}
            </option>
          ))}
        </select>
        {suggestion ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm" data-testid="journey-suggestion">
            <span className="text-rubric">This may suit the {suggestion.name.toLowerCase()} journey.</span>
            <button type="button" className={btnQuiet} onClick={() => setKey(suggestion.key)}>
              Show its steps
            </button>
          </div>
        ) : null}
      </div>
      {option ? (
        <>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-0 flex-1 basis-44">
              <label htmlFor={`${idPrefix}-anchor`} className={labelClass}>
                {option.anchorLabel}
              </label>
              <input id={`${idPrefix}-anchor`} name="journeyAnchor" type="date" required value={anchor} onChange={(e) => setAnchor(e.target.value)} className={inputClass} />
            </div>
            {option.secondLabel ? (
              <div className="min-w-0 flex-1 basis-44">
                <label htmlFor={`${idPrefix}-second`} className={labelClass}>
                  {option.secondLabel}
                </label>
                <input id={`${idPrefix}-second`} name="journeySecond" type="date" value={second} onChange={(e) => setSecond(e.target.value)} className={inputClass} />
              </div>
            ) : null}
            {option.standing ? (
              <div className="min-w-0 flex-1 basis-44">
                <label htmlFor={`${idPrefix}-weeks`} className={labelClass}>
                  Be in touch every (weeks)
                </label>
                <input id={`${idPrefix}-weeks`} name="journeyInterval" type="number" inputMode="numeric" min={1} max={26} required value={weeks} onChange={(e) => setWeeks(e.target.value)} className={inputClass} />
              </div>
            ) : null}
          </div>

          {problem ? <p className="text-sm font-medium text-alert">{problem}</p> : null}
          {preview ? (
            <fieldset className={fieldsetClass} aria-describedby={stepsId} data-testid="journey-preview">
              <input type="hidden" name="journeyPreviewed" value="yes" />
              <legend className={legendClass}>Steps it will add</legend>
              <p id={stepsId} className="mb-1 text-sm text-rubric">
                {option.standing ? "The next one is added each time the last is done." : "Untick any step you do not want. A date already past is set for today."}
              </p>
              <ul className="flex flex-col">
                {preview.steps.map((s) => (
                  <li key={s.stepId}>
                    <label className="flex min-h-11 items-start gap-3 py-1.5" data-testid="journey-preview-step">
                      <input type="checkbox" name="journeyStep" value={s.stepId} defaultChecked className={`${checkBox} mt-0.5`} />
                      <span className="min-w-0">
                        <span className="block text-base">{s.title}</span>
                        <span className="block text-sm text-rubric">
                          {shortDate(s.dueDate)}
                          {s.who === "lead" ? " · Mitzvah Corps" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : pending ? (
            <p className="text-sm text-rubric" role="status">
              Working out the dates…
            </p>
          ) : null}

          {preview && leadSteps ? (
            <div>
              <label htmlFor={`${idPrefix}-lead`} className={labelClass}>
                Mitzvah Corps steps go to
              </label>
              <select id={`${idPrefix}-lead`} name="journeyLead" defaultValue={preview.defaultLeadId ?? ""} key={preview.defaultLeadId ?? "none"} className={inputClass}>
                <option value="">The care item&rsquo;s holder, marked for Mitzvah Corps</option>
                {preview.leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-sm text-rubric">A lead sees only the person&rsquo;s name, the step and its date. On a restricted item these steps always stay with its holder.</p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
