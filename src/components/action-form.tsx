"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import { useSheet } from "./sheet";

/**
 * A form wired to a server action. It disables itself while saving, shows the
 * action's calm message beside the controls, and closes its sheet on success.
 *
 * The action is dispatched from onSubmit rather than through the form's `action`
 * prop: React 19 empties the fields of an `action` form once it finishes, even when
 * it failed, which would wipe a long pastoral note. Here the fields are cleared
 * (form.reset) only after success. Nothing the user typed is sent back or logged.
 * `action` stays on the form so the server-rendered markup is a POST: a submit before
 * hydration must never fall back to a GET that puts a note in the URL.
 */
export function ActionForm({
  action,
  children,
  className,
  closeSheetOnOk = true,
  showOk = true,
  onOk,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  closeSheetOnOk?: boolean;
  showOk?: boolean;
  /** Called once each time the action succeeds (a screen that tracks what is still to do). */
  onOk?: () => void;
}) {
  const [state, dispatch, pending] = useActionState(action, IDLE);
  const sheet = useSheet();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status !== "ok") return;
    ref.current?.reset();
    if (closeSheetOnOk) sheet?.close();
    onOk?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a new result arrives, not when the callback is re-created
  }, [state]);
  return (
    <form
      ref={ref}
      className={className}
      action={dispatch}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => dispatch(data));
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      <p role="status" aria-live="polite" className={`mt-2 text-sm empty:hidden ${state.status === "error" ? "font-medium text-alert" : "font-medium text-done"}`}>
        {state.status === "error" || (showOk && state.status === "ok") ? state.message : ""}
      </p>
    </form>
  );
}
