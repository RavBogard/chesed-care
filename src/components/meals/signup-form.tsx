"use client";

import Link from "next/link";
import { startTransition, useActionState } from "react";
import { signUpAction, type SignupState } from "@/app/m/actions";
import { btnLaptopNatural, btnPrimary, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { FOOD_TYPE_WORDS } from "@/lib/meals-wording";
import { BotGuard } from "@/components/bot-guard";

const IDLE: SignupState = { status: "idle" };
const FOODS = ["meat", "dairy", "pareve", "not_sure"] as const;

/**
 * One step: who you are, what you are bringing, and whether you cook or send a delivery.
 * The night is already chosen (it came from the date list). `stamp` is the server's signed
 * render time; `website` is the honeypot, hidden from sight and from the keyboard.
 * The fields keep what was typed when a sign-up is refused.
 */
export function SignupForm({ token, slotId, night, stamp, changeHref }: { token: string; slotId: string; night: string; stamp: string; changeHref: string }) {
  const [state, dispatch, pending] = useActionState(signUpAction, IDLE);
  const bad = new Set(state.status === "error" ? state.fields : []);
  const err = (name: string) => (bad.has(name) ? { "aria-invalid": true as const, "aria-describedby": "signup-error" } : {});
  return (
    <form
      action={dispatch}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => dispatch(data));
      }}
      data-testid="signup-form"
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="slotId" value={slotId} />
      <BotGuard stamp={stamp} />

      <p className="text-base">
        You are taking <strong>{night}</strong>.{" "}
        <Link href={changeHref} scroll={false} className="font-medium text-action underline underline-offset-4">
          Choose a different night
        </Link>
      </p>

      <fieldset disabled={pending} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="su-first" className={labelClass}>
              First name
            </label>
            <input id="su-first" name="firstName" required maxLength={60} autoComplete="given-name" className={inputClass} {...err("firstName")} />
          </div>
          <div>
            <label htmlFor="su-last" className={labelClass}>
              Last name
            </label>
            <input id="su-last" name="lastName" required maxLength={60} autoComplete="family-name" className={inputClass} {...err("lastName")} />
          </div>
        </div>
        <div>
          <label htmlFor="su-email" className={labelClass}>
            Email
          </label>
          <input id="su-email" name="email" type="email" required maxLength={254} autoComplete="email" inputMode="email" className={inputClass} aria-describedby="su-email-help" {...(bad.has("email") ? { "aria-invalid": true as const } : {})} />
          <p id="su-email-help" className="mt-1 text-sm text-rubric">
            The congregation keeps it.
          </p>
        </div>

        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>How will you help?</legend>
          <label className={checkRow}>
            <input type="radio" name="kind" value="cook" defaultChecked className={checkBox} />I will cook and bring a meal
          </label>
          <label className={checkRow}>
            <input type="radio" name="kind" value="delivery" className={checkBox} />I will send a delivery
          </label>
        </fieldset>

        <div>
          <label htmlFor="su-bringing" className={labelClass}>
            What are you bringing?
          </label>
          <input id="su-bringing" name="bringing" maxLength={200} className={inputClass} {...err("bringing")} />
        </div>

        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>Is it meat, dairy or pareve?</legend>
          <div className="flex flex-wrap gap-x-6">
            {FOODS.map((f) => (
              <label key={f} className={checkRow}>
                <input type="radio" name="foodType" value={f} defaultChecked={f === "not_sure"} className={checkBox} />
                {FOOD_TYPE_WORDS[f]}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="su-note" className={labelClass}>
            A note for the family or the organiser (optional)
          </label>
          <textarea id="su-note" name="note" rows={3} maxLength={300} className={`${inputClass} py-2`} {...err("note")} />
        </div>

        <label className={checkRow}>
          <input type="checkbox" name="mayContactAgain" className={checkBox} />
          You may ask me again for another family
        </label>
      </fieldset>

      <p id="signup-error" role="alert" className="text-base font-medium text-alert empty:hidden">
        {state.status === "error" ? state.message : ""}
      </p>
      <button type="submit" disabled={pending} className={`${btnPrimary} ${btnLaptopNatural}`}>
        {pending ? "Signing you up" : "Sign me up"}
      </button>
    </form>
  );
}
