"use client";

import { startTransition, useActionState } from "react";
import { flagAction, type FlagState } from "@/app/v/actions";
import { BotGuard } from "@/components/bot-guard";
import { btnLaptopNatural, btnQuiet, inputClass, labelClass } from "@/components/ui";
import { FLAG_MAX, FLAG_WORDS } from "@/lib/volunteers-wording";

const IDLE: FlagState = { status: "idle" };

/**
 * "Something a rabbi should know" on a volunteer's own page: a control that opens a short box. Once sent, the box
 * gives way to one sentence and nothing else (no Inbox, no id). The words stay in the box after a refusal, so
 * nothing written is lost. `stamp` is the server's signed render time; `website` is the honeypot.
 */
export function FlagForm({ token, stamp }: { token: string; stamp: string }) {
  const [state, dispatch, pending] = useActionState(flagAction, IDLE);
  if (state.status === "sent") {
    return (
      <p role="status" className="mt-4 text-base font-medium text-done" data-testid="flag-sent">
        {FLAG_WORDS.sent}
      </p>
    );
  }
  return (
    <details className="mt-4" data-testid="flag">
      <summary className={`${btnQuiet} ${btnLaptopNatural} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>{FLAG_WORDS.open}</summary>
      <p className="mt-3 max-w-prose text-base" data-testid="flag-guidance">
        {FLAG_WORDS.guidance}
      </p>
      <form
        action={dispatch}
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startTransition(() => dispatch(data));
        }}
      >
        <input type="hidden" name="token" value={token} />
        <BotGuard stamp={stamp} />
        <fieldset disabled={pending} className="contents">
          <div>
            <label htmlFor="mc-flag" className={labelClass}>
              {FLAG_WORDS.label}
            </label>
            <textarea id="mc-flag" name="words" required rows={4} maxLength={FLAG_MAX} className={`${inputClass} py-2`} aria-describedby="mc-flag-status" />
          </div>
          <button type="submit" className={`${btnQuiet} ${btnLaptopNatural}`}>
            {pending ? FLAG_WORDS.sending : FLAG_WORDS.send}
          </button>
        </fieldset>
        <p id="mc-flag-status" role="status" aria-live="polite" className="text-sm font-medium text-alert empty:hidden">
          {state.status === "error" ? state.message : ""}
        </p>
      </form>
    </details>
  );
}
