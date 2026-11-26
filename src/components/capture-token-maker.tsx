"use client";

import { startTransition, useActionState } from "react";
import { createCaptureTokenAction, type NewTokenState } from "@/app/settings-actions";
import { SHORTCUT_MAKE, SHORTCUT_SHOWN_ONCE } from "@/lib/shortcut-wording";
import { CopyButton } from "./copy-button";
import { btnQuiet } from "./ui";

const IDLE: NewTokenState = { status: "idle" };

/** Makes a key and shows it once, here, with a copy button. Nothing of it is kept in the page afterwards. */
export function CaptureTokenMaker({ full }: { full: boolean }) {
  const [state, dispatch, pending] = useActionState(async () => createCaptureTokenAction(), IDLE);
  return (
    <div className="mt-3 flex flex-col items-start gap-3">
      {state.status === "ok" ? (
        <div role="status" className="w-full rounded-md border-2 border-action bg-surface p-3" data-testid="new-capture-token">
          <p className="text-sm font-semibold">{SHORTCUT_SHOWN_ONCE}</p>
          <code className="mt-2 block break-all rounded-md bg-tint px-3 py-2 text-sm">{state.token}</code>
          <div className="mt-2">
            <CopyButton text={state.token} label="Copy key" />
          </div>
        </div>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="text-base font-medium text-alert">
          {state.message}
        </p>
      ) : null}
      {!full ? (
        <button type="button" disabled={pending} className={btnQuiet} onClick={() => startTransition(() => dispatch())}>
          {SHORTCUT_MAKE}
        </button>
      ) : null}
    </div>
  );
}
