import { saveJourneyTemplateAction } from "@/app/journey-actions";
import type { TemplateView } from "@/server/journeys/template-store";
import { TEMPLATE_META, type JourneyStep, type RuleKind, type StepRule } from "@/server/journeys/templates";
import { ActionForm } from "./action-form";
import { btnPrimary, btnQuiet, checkBox, fieldsetClass, inputClass, labelClass, legendClass, titleClass } from "./ui";

const RULE_LABEL: Record<RuleKind, string> = {
  days: "days after the start date",
  months: "months after the start date",
  after_second: "days after discharge (a week in, if not known)",
  before_rosh_hashana: "days before the first Rosh Hashanah",
  before_pesach: "days before the first Pesach",
  before_first_yahrzeit: "days before the first yahrzeit",
  every: "every few weeks, set when it starts",
};

const amountOf = (rule: StepRule) => (rule.kind === "every" ? 0 : rule.kind === "months" ? rule.months : rule.days);

/** The fields of one step: what it says, who it is for, and when. */
function StepFields({ step, prefix, rules, leadSteps, legend, removable }: { step: JourneyStep | null; prefix: string; rules: readonly RuleKind[]; leadSteps: boolean; legend: string; removable: boolean }) {
  const rule = step?.rule.kind ?? rules[0];
  return (
    <fieldset className={`${fieldsetClass} flex flex-col gap-3`} data-testid="template-step">
      <legend className={legendClass}>{legend}</legend>
      {step ? <input type="hidden" name={`${prefix}_id`} value={step.id} /> : null}
      {step?.link ? <input type="hidden" name={`${prefix}_link`} value={step.link} /> : null}
      <div>
        <label htmlFor={`${prefix}-title`} className={labelClass}>
          What to do
        </label>
        <input id={`${prefix}-title`} name={`${prefix}_title`} defaultValue={step?.title ?? ""} maxLength={120} required={step !== null} className={inputClass} />
      </div>
      <div className="flex flex-wrap gap-3">
        {rule !== "every" ? (
          <div className="w-24 shrink-0">
            <label htmlFor={`${prefix}-amount`} className={labelClass}>
              When
            </label>
            <input id={`${prefix}-amount`} name={`${prefix}_amount`} type="number" inputMode="numeric" min={0} max={400} defaultValue={step ? amountOf(step.rule) : 0} className={inputClass} />
          </div>
        ) : null}
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor={`${prefix}-rule`} className={rule === "every" ? labelClass : "sr-only"}>
            {rule === "every" ? "When" : "Counted as"}
          </label>
          <select id={`${prefix}-rule`} name={`${prefix}_rule`} defaultValue={rule} className={`${inputClass} ${rule === "every" ? "" : "mt-6"}`}>
            {rules.map((r) => (
              <option key={r} value={r}>
                {RULE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {leadSteps ? (
        <div>
          <label htmlFor={`${prefix}-who`} className={labelClass}>
            For
          </label>
          <select id={`${prefix}-who`} name={`${prefix}_who`} defaultValue={step?.who ?? "clergy"} className={inputClass}>
            <option value="clergy">The clergy holding the care</option>
            <option value="lead">The Mitzvah Corps lead</option>
          </select>
        </div>
      ) : (
        <input type="hidden" name={`${prefix}_who`} value="clergy" />
      )}
      {step && removable ? (
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" name={`${prefix}_remove`} className={checkBox} />
          Remove this step
        </label>
      ) : null}
    </fieldset>
  );
}

/**
 * One template's steps, editable: titles, when each falls, who it is for; remove a step, add
 * one, or go back to the default. A change applies to journeys started afterwards.
 */
export function JourneyTemplateForm({ template }: { template: TemplateView }) {
  const meta = TEMPLATE_META[template.key];
  return (
    <details className="rounded-md border border-rule bg-surface" data-testid="journey-template">
      <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 py-2">
        <span className={titleClass}>{template.name}</span>
        <span className="text-sm text-rubric">
          {template.steps.length === 1 ? "1 step" : `${template.steps.length} steps`}
          {template.isDefault ? "" : " · changed"}
        </span>
      </summary>
      <ActionForm action={saveJourneyTemplateAction} className="flex flex-col gap-3 border-t border-rule px-4 pb-4 pt-3" closeSheetOnOk={false}>
        <input type="hidden" name="templateKey" value={template.key} />
        <input type="hidden" name="stepCount" value={template.steps.length} />
        <p className="text-sm text-rubric">
          The start date is the {meta.anchorLabel.toLowerCase()}
          {meta.second ? `; the second date is the ${meta.second.label.replace(/ \(if known\)$/, "").toLowerCase()}` : ""}. Changes apply to journeys started from now on.
        </p>
        {template.steps.map((s, i) => (
          <StepFields key={s.id} step={s} prefix={`step_${i}`} rules={meta.rules} leadSteps={meta.leadSteps} legend={`Step ${i + 1}`} removable={!meta.standing} />
        ))}
        {meta.standing ? null : <StepFields step={null} prefix="new" rules={meta.rules} leadSteps={meta.leadSteps} legend="Add a step (leave blank to skip)" removable={false} />}
        <div className="flex flex-wrap gap-2">
          <button type="submit" name="intent" value="save" className={btnPrimary}>
            Save steps
          </button>
          {template.isDefault ? null : (
            <button type="submit" name="intent" value="reset" formNoValidate className={btnQuiet}>
              Reset to the default
            </button>
          )}
        </div>
      </ActionForm>
    </details>
  );
}
