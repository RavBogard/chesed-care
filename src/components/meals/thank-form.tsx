import { thankHelperAction } from "@/app/m/actions";
import { ActionForm } from "@/components/action-form";
import { Sheet } from "@/components/sheet";
import { btnPrimary, inputClass, labelClass } from "@/components/ui";

/** A line of thanks to one helper, in a small dialog. The helper sees it on their own page. */
export function ThankForm({ token, signupId, name }: { token: string; signupId: string; name: string }) {
  return (
    <Sheet label="Thank" ariaLabel={`Thank ${name}`} title={`Thank ${name}`}>
      <ActionForm action={thankHelperAction} className="flex flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="signupId" value={signupId} />
        <label htmlFor={`thanks-${signupId}`} className={labelClass}>
          Your message
        </label>
        <textarea id={`thanks-${signupId}`} name="text" rows={3} required maxLength={300} className={`${inputClass} py-2`} />
        <button type="submit" className={btnPrimary}>
          Send thanks
        </button>
      </ActionForm>
    </Sheet>
  );
}
