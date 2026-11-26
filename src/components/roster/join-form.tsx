"use client";

import { startTransition, useActionState } from "react";
import { joinAction, type JoinState } from "@/app/join/actions";
import { btnLaptopNatural, btnPrimary, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { CAN_DO_LABEL, HOW_OFTEN_LABEL, HOW_OFTEN_QUESTION, JOIN_AVAILABILITY_HINT, JOIN_LABELS, JOIN_SENDING, JOIN_SUBMIT, JOIN_THANKS, JOIN_THANKS_HEADING, PREFER_CONTACT_LABEL, PREFER_CONTACT_QUESTION } from "@/lib/roster-wording";
import { CAN_DO, HOW_OFTEN, PREFER_CONTACT } from "@/lib/can-do";
import { BotGuard } from "@/components/bot-guard";

const IDLE: JoinState = { status: "idle" };

/** `stamp` is the server's signed render time; `website` is the honeypot, hidden from sight and from the keyboard. */
export function JoinForm({ stamp }: { stamp: string }) {
  const [state, dispatch, pending] = useActionState(joinAction, IDLE);
  if (state.status === "sent") {
    // The same screen for every submission: it says nothing about whether the person was already on the list.
    return (
      <div role="status" className="mt-6" data-testid="join-thanks">
        <h2 className="font-serif text-2xl font-bold">{JOIN_THANKS_HEADING}</h2>
        <p className="mt-2 max-w-prose text-lg">{JOIN_THANKS}</p>
      </div>
    );
  }
  const bad = new Set(state.status === "error" ? state.fields : []);
  const err = (name: string) => (bad.has(name) ? { "aria-invalid": true as const, "aria-describedby": "join-error" } : {});
  return (
    <form
      action={dispatch}
      className="mt-6 flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => dispatch(data));
      }}
      data-testid="join-form"
    >
      <BotGuard stamp={stamp} />
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="join-first" className={labelClass}>
              {JOIN_LABELS.firstName}
            </label>
            <input id="join-first" name="firstName" required maxLength={60} autoComplete="given-name" className={inputClass} {...err("firstName")} />
          </div>
          <div>
            <label htmlFor="join-last" className={labelClass}>
              {JOIN_LABELS.lastName}
            </label>
            <input id="join-last" name="lastName" required maxLength={60} autoComplete="family-name" className={inputClass} {...err("lastName")} />
          </div>
        </div>
        <div>
          <label htmlFor="join-contact" className={labelClass}>
            {JOIN_LABELS.contact}
          </label>
          <input id="join-contact" name="contact" required maxLength={254} autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={inputClass} {...err("contact")} />
        </div>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{JOIN_LABELS.canDo}</legend>
          {CAN_DO.map((k) => (
            <label key={k} className={checkRow}>
              <input type="checkbox" name="canDo" value={k} className={checkBox} />
              {CAN_DO_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <div>
          <label htmlFor="join-when" className={labelClass}>
            {JOIN_LABELS.availability}
          </label>
          <input id="join-when" name="availability" maxLength={200} className={inputClass} aria-describedby="join-when-help" />
          <p id="join-when-help" className="mt-1 text-sm text-rubric">
            {JOIN_AVAILABILITY_HINT}
          </p>
        </div>
        <div>
          <label htmlFor="join-often" className={labelClass}>
            {HOW_OFTEN_QUESTION}
          </label>
          <select id="join-often" name="howOften" defaultValue="" className={inputClass}>
            <option value=""></option>
            {HOW_OFTEN.map((k) => (
              <option key={k} value={k}>
                {HOW_OFTEN_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="join-prefer" className={labelClass}>
            {PREFER_CONTACT_QUESTION}
          </label>
          <select id="join-prefer" name="preferContact" defaultValue="" className={inputClass}>
            <option value=""></option>
            {PREFER_CONTACT.map((k) => (
              <option key={k} value={k}>
                {PREFER_CONTACT_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <label className={`${checkRow} items-start py-2`}>
          <input type="checkbox" name="consent" required className={`${checkBox} mt-1`} {...err("consent")} />
          <span>{JOIN_LABELS.consent}</span>
        </label>
      </fieldset>
      <p id="join-error" role="alert" className="text-base font-medium text-alert empty:hidden">
        {state.status === "error" ? state.message : ""}
      </p>
      <button type="submit" disabled={pending} className={`${btnPrimary} ${btnLaptopNatural}`}>
        {pending ? JOIN_SENDING : JOIN_SUBMIT}
      </button>
    </form>
  );
}
