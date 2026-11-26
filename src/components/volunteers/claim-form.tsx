"use client";

import { startTransition, useActionState } from "react";
import { claimAction, claimEveryTimeAction, type ClaimState } from "@/app/v/actions";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, inputClass, labelClass } from "@/components/ui";
import { EVERY_TIME_BUTTON, EVERY_TIME_NOTE } from "@/lib/roster-wording";
import { BotGuard } from "@/components/bot-guard";

const IDLE: ClaimState = { status: "idle" };

/**
 * One step: who you are, one way to reach you, and an optional note. What is being taken is
 * already chosen (the page's task, or the evening picked on a shiva sheet). `stamp` is the
 * server's signed render time; `website` is the honeypot, hidden from sight and from the keyboard.
 * The fields keep what was typed when a claim is refused. On one date of a repeating task (`everyTime`: how many dates
 * are still open) a second button signs the volunteer up for all of them at once.
 */
export function ClaimForm({ token, taskId, stamp, what, everyTime = 0 }: { token: string; taskId?: string; stamp: string; what: string; everyTime?: number }) {
  const [oneState, dispatchOne, pendingOne] = useActionState(claimAction, IDLE);
  const [allState, dispatchAll, pendingAll] = useActionState(claimEveryTimeAction, IDLE);
  const state = allState.status === "error" ? allState : oneState;
  const pending = pendingOne || pendingAll;
  const dispatch = dispatchOne;
  const bad = new Set(state.status === "error" ? state.fields : []);
  const err = (name: string) => (bad.has(name) ? { "aria-invalid": true as const, "aria-describedby": "claim-error" } : {});
  return (
    <form
      action={dispatch}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => (data.get("scope") === "all" ? dispatchAll(data) : dispatchOne(data)));
      }}
      data-testid="claim-form"
    >
      <input type="hidden" name="token" value={token} />
      {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
      <BotGuard stamp={stamp} />

      <p className="text-base">
        You are signing up for <strong>{what}</strong>.
      </p>

      <fieldset disabled={pending} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="cl-first" className={labelClass}>
              First name
            </label>
            <input id="cl-first" name="firstName" required maxLength={60} autoComplete="given-name" className={inputClass} {...err("firstName")} />
          </div>
          <div>
            <label htmlFor="cl-last" className={labelClass}>
              Last name
            </label>
            <input id="cl-last" name="lastName" required maxLength={60} autoComplete="family-name" className={inputClass} {...err("lastName")} />
          </div>
        </div>
        <div>
          <label htmlFor="cl-contact" className={labelClass}>
            Email or mobile number
          </label>
          <input id="cl-contact" name="contact" required maxLength={254} autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={inputClass} aria-describedby="cl-contact-help" {...(bad.has("contact") ? { "aria-invalid": true as const } : {})} />
          <p id="cl-contact-help" className="mt-1 text-sm text-rubric">
            Only the people organising this can see it. The congregation keeps it.
          </p>
        </div>
        <div>
          <label htmlFor="cl-note" className={labelClass}>
            A note (optional)
          </label>
          <textarea id="cl-note" name="note" rows={3} maxLength={200} className={`${inputClass} py-2`} {...err("note")} />
        </div>
        <label className={checkRow}>
          <input type="checkbox" name="mayAskAgain" className={checkBox} />
          You may ask me again
        </label>
      </fieldset>

      <p id="claim-error" role="alert" className="text-base font-medium text-alert empty:hidden">
        {state.status === "error" ? state.message : ""}
      </p>
      <div className="flex flex-col gap-2">
        <button type="submit" name="scope" value="one" disabled={pending} className={`${btnPrimary} ${btnLaptopNatural}`}>
          {pending ? "Signing you up" : "I can help"}
        </button>
        {everyTime > 1 ? (
          <>
            <button type="submit" name="scope" value="all" disabled={pending} className={`${btnQuiet} ${btnLaptopNatural}`} aria-describedby="every-time-note" data-testid="every-time">
              {EVERY_TIME_BUTTON}
            </button>
            <p id="every-time-note" className="text-sm text-rubric">
              {EVERY_TIME_NOTE} ({everyTime} dates)
            </p>
          </>
        ) : null}
      </div>
    </form>
  );
}
