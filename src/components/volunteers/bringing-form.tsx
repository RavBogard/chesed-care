import { bringingAction } from "@/app/v/actions";
import { ActionForm } from "@/components/action-form";
import { btnLaptopNatural, btnQuiet, inputClass, labelClass } from "@/components/ui";
import { BotGuard } from "@/components/bot-guard";

/** "I am bringing": a first name and a line. `stamp` is the server's signed render time; `website` is the honeypot. */
export function BringingForm({ token, stamp }: { token: string; stamp: string }) {
  return (
    <ActionForm action={bringingAction} className="flex flex-col gap-3" closeSheetOnOk={false}>
      <input type="hidden" name="token" value={token} />
      <BotGuard stamp={stamp} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <div>
          <label htmlFor="br-first" className={labelClass}>
            First name
          </label>
          <input id="br-first" name="firstName" required maxLength={60} autoComplete="given-name" className={inputClass} />
        </div>
        <div>
          <label htmlFor="br-line" className={labelClass}>
            What you are bringing
          </label>
          <input id="br-line" name="line" required maxLength={120} className={inputClass} />
        </div>
      </div>
      <button type="submit" className={`${btnQuiet} ${btnLaptopNatural}`}>
        Add to the list
      </button>
    </ActionForm>
  );
}
