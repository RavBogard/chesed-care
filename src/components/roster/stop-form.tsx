"use client";

import { startTransition, useActionState } from "react";
import { stopAction, type StopState } from "@/app/join/actions";
import { btnLaptopNatural, btnPrimary } from "@/components/ui";
import { STOP_BUTTON, STOP_DONE, STOP_DONE_HEADING } from "@/lib/roster-wording";
import { BotGuard } from "@/components/bot-guard";

const IDLE: StopState = { status: "idle" };

/** The one button. Opening the page does nothing; only this POST stops the asks. `website` is the honeypot. */
export function StopForm({ token }: { token: string }) {
  const [state, dispatch, pending] = useActionState(stopAction, IDLE);
  if (state.status === "stopped") {
    return (
      <div role="status" className="mt-6" data-testid="stop-done">
        <h2 className="font-serif text-2xl font-bold">{STOP_DONE_HEADING}</h2>
        <p className="mt-2 max-w-prose text-lg">{STOP_DONE}</p>
      </div>
    );
  }
  return (
    <form
      action={dispatch}
      className="mt-6 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => dispatch(data));
      }}
      data-testid="stop-form"
    >
      <input type="hidden" name="token" value={token} />
      <BotGuard />
      <p role="alert" className="text-base font-medium text-alert empty:hidden">
        {state.status === "error" ? state.message : ""}
      </p>
      <button type="submit" disabled={pending} className={`${btnPrimary} ${btnLaptopNatural}`}>
        {STOP_BUTTON}
      </button>
    </form>
  );
}
