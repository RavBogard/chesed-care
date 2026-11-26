"use client";

import { startTransition, useActionState } from "react";
import { tellAction, type TellState } from "@/app/tell/actions";
import { btnLaptopNatural, btnPrimary, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { TELL_ANSWERS, TELL_HELP_ANSWERS, TELL_HELP_NOTE, TELL_KEEP, TELL_LABELS, TELL_PRIVACY, TELL_SENDING, TELL_SUBMIT, TELL_THANKS, TELL_THANKS_HEADING } from "@/lib/tell-wording";
import { BotGuard } from "@/components/bot-guard";

const IDLE: TellState = { status: "idle" };

/** `stamp` is the server's signed render time; `website` is the honeypot, hidden from sight and from the keyboard. */
export function TellForm({ stamp }: { stamp: string }) {
  const [state, dispatch, pending] = useActionState(tellAction, IDLE);
  if (state.status === "sent") {
    // The same screen for every submission: it says nothing about the person.
    return (
      <div role="status" className="mt-6" data-testid="tell-thanks">
        <h2 className="font-serif text-2xl font-bold">{TELL_THANKS_HEADING}</h2>
        <p className="mt-2 max-w-prose text-lg">{TELL_THANKS}</p>
      </div>
    );
  }
  const bad = new Set(state.status === "error" ? state.fields : []);
  const err = (name: string) => (bad.has(name) ? { "aria-invalid": true as const, "aria-describedby": "tell-error" } : {});
  return (
    <form
      action={dispatch}
      className="mt-6 flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => dispatch(data));
      }}
      data-testid="tell-form"
    >
      <BotGuard stamp={stamp} />
      <fieldset disabled={pending} className="flex flex-col gap-5">
        <div>
          <label htmlFor="tell-about" className={labelClass}>
            {TELL_LABELS.about}
          </label>
          <input id="tell-about" name="about" required maxLength={200} autoComplete="off" className={inputClass} {...err("about")} />
        </div>
        <div>
          <label htmlFor="tell-what" className={labelClass}>
            {TELL_LABELS.what}
          </label>
          <textarea id="tell-what" name="what" required rows={5} maxLength={1000} className={`${inputClass} py-2`} {...err("what")} />
        </div>
        <div>
          <label htmlFor="tell-sender" className={labelClass}>
            {TELL_LABELS.sender}
          </label>
          <input id="tell-sender" name="sender" required maxLength={200} autoComplete="name" className={inputClass} {...err("sender")} />
        </div>
        <div>
          <label htmlFor="tell-contact" className={labelClass}>
            {TELL_LABELS.contact}
          </label>
          <input id="tell-contact" name="contact" required maxLength={254} autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={inputClass} {...err("contact")} />
        </div>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{TELL_LABELS.help}</legend>
          {(["clergy", "practical"] as const).map((v) => (
            <label key={v} className={checkRow}>
              <input type="radio" name="help" value={v} required defaultChecked={v === "clergy"} className={checkBox} />
              {TELL_HELP_ANSWERS[v]}
            </label>
          ))}
          <p className="mt-1 text-sm text-rubric" data-testid="tell-help-note">
            {TELL_HELP_NOTE}
          </p>
        </fieldset>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{TELL_LABELS.mayTellThem}</legend>
          {(["yes", "no"] as const).map((v) => (
            <label key={v} className={checkRow}>
              <input type="radio" name="mayTellThem" value={v} defaultChecked={v === "no"} className={checkBox} />
              {TELL_ANSWERS[v]}
            </label>
          ))}
          <p className="mt-1 text-sm text-rubric" data-testid="tell-keep">
            {TELL_KEEP}
          </p>
        </fieldset>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{TELL_LABELS.miSheberach}</legend>
          {(["yes", "no", "not_sure"] as const).map((v) => (
            <label key={v} className={checkRow}>
              <input type="radio" name="miSheberach" value={v} defaultChecked={v === "not_sure"} className={checkBox} />
              {TELL_ANSWERS[v]}
            </label>
          ))}
        </fieldset>
      </fieldset>
      <p className="text-sm text-rubric">{TELL_PRIVACY}</p>
      <p id="tell-error" role="alert" className="text-base font-medium text-alert empty:hidden">
        {state.status === "error" ? state.message : ""}
      </p>
      <button type="submit" disabled={pending} className={`${btnPrimary} ${btnLaptopNatural}`}>
        {pending ? TELL_SENDING : TELL_SUBMIT}
      </button>
    </form>
  );
}
