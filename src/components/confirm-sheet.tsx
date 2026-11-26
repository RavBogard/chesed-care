"use client";

import type { ActionState } from "@/lib/action-state";
import { ActionForm } from "./action-form";
import { Sheet, useSheet } from "./sheet";
import { btnPrimary, btnQuiet } from "./ui";

function Cancel() {
  const sheet = useSheet();
  return (
    <button type="button" data-autofocus className={btnQuiet} onClick={() => sheet?.close()}>
      Cancel
    </button>
  );
}

/**
 * A one-tap action: a POST form that carries only its hidden `fields` and the one button. The same
 * shape as ConfirmAction, without the second look.
 */
export function ActionButton({
  action,
  fields,
  label,
  className,
  formClassName,
  ariaLabel,
  closeSheetOnOk,
  showOk,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  label: string;
  className: string;
  formClassName?: string;
  ariaLabel?: string;
  closeSheetOnOk?: boolean;
  showOk?: boolean;
}) {
  return (
    <ActionForm action={action} className={formClassName} closeSheetOnOk={closeSheetOnOk} showOk={showOk}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className={className} aria-label={ariaLabel}>
        {label}
      </button>
    </ActionForm>
  );
}

/**
 * A one-tap action that needs a second look: the button opens a small dialog that says what
 * will happen, with the action's own button beside Cancel. Focus starts on Cancel.
 */
export function ConfirmAction({
  action,
  fields,
  label,
  title,
  explain,
  confirmLabel,
  ariaLabel,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  label: string;
  title: string;
  explain: string;
  confirmLabel: string;
  ariaLabel?: string;
}) {
  return (
    <Sheet label={label} title={title} ariaLabel={ariaLabel}>
      <p className="mb-4 text-base">{explain}</p>
      <ActionForm action={action} showOk={false}>
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <div className="flex flex-wrap gap-2">
          <Cancel />
          <button type="submit" className={btnPrimary}>
            {confirmLabel}
          </button>
        </div>
      </ActionForm>
    </Sheet>
  );
}
