import { removeDeviceAction, saveNotificationPrefsAction, sendTestNotificationAction } from "@/app/notifications-actions";
import { ActionForm } from "@/components/action-form";
import { Section } from "@/components/section";
import { btnLaptopNatural, btnPrimary, btnQuiet, cardClass, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass, titleClass } from "@/components/ui";
import type { PrefKind } from "@/lib/notice";
import { instantDate } from "@/lib/format";
import type { Prefs } from "@/server/notify/prefs";
import type { DeviceView } from "@/server/notify/subscriptions";
import { DeviceControl } from "./device-control";
import { ActionButton } from "@/components/confirm-sheet";

const KIND_WORDS: Record<PrefKind, { label: string; help: string }> = {
  urgent_inbox: { label: "Urgent Inbox items", help: "When something in your Inbox needs you today." },
  new_inbox: { label: "New Inbox items", help: "A count of what has arrived, at most once every 30 minutes." },
  assigned: { label: "Passed to me", help: "When someone gives you a care item or a follow-up." },
  coordinator: { label: "Volunteer places", help: "When a volunteer place opens up close to its date, and when tasks within two days still need someone." },
};

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export type NotificationsView = {
  /** The public key the browser needs, or null when phone notifications are not set up. */
  publicKey: string | null;
  /** Owner only: the variable names still missing. Never a value. */
  missing: string[] | null;
  devices: DeviceView[];
  prefs: Prefs;
  kinds: { kind: PrefKind; on: boolean }[];
};

export function NotificationsSection({ view }: { view: NotificationsView }) {
  const { publicKey, missing, devices, prefs, kinds } = view;
  return (
    <Section title="Notifications">
      <p className="mt-2 max-w-prose text-sm text-rubric">A notification on your phone is one short sentence and sometimes a number, never a name or a note. Tap it to open CRC Care.</p>
      {missing ? (
        <p className="mt-2 max-w-prose text-sm text-rubric" data-testid="push-config">
          {missing.length === 0 ? "Set up: all three keys are in place." : `Not set up yet. Missing: ${missing.join(", ")}.`}
        </p>
      ) : null}
      {publicKey === null ? (
        <p className="mt-3 max-w-prose text-base" data-testid="push-not-configured">
          Phone notifications are not switched on yet.
        </p>
      ) : (
        <>
          <DeviceControl publicKey={publicKey} />

          <h3 className={`${titleClass} mt-6`}>Your devices</h3>
          {devices.length === 0 ? (
            <p className="mt-2 text-sm text-rubric" data-testid="push-no-devices">
              No device has notifications on yet.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3" data-testid="push-devices">
              {devices.map((d) => (
                <li key={d.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
                  <div className="min-w-0">
                    <p className="text-base font-semibold">{d.deviceLabel}</p>
                    <p className="text-sm text-rubric">Turned on {instantDate(d.createdAt)}</p>
                  </div>
                  <ActionForm action={removeDeviceAction} closeSheetOnOk={false}>
                    <input type="hidden" name="deviceId" value={d.id} />
                    <button type="submit" className={btnQuiet}>
                      Turn off
                      <span className="sr-only"> on this {d.deviceLabel}</span>
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          {devices.length > 0 ? (
            <ActionButton action={sendTestNotificationAction} fields={{}} label="Send me a test" className={btnQuiet} formClassName="mt-3" closeSheetOnOk={false} />
          ) : null}

          <h3 className={`${titleClass} mt-6`}>What to tell me</h3>
          <ActionForm action={saveNotificationPrefsAction} className="mt-3 flex flex-col gap-4" closeSheetOnOk={false}>
            {kinds.length > 0 ? (
              <fieldset className={fieldsetClass} data-testid="push-kinds">
                <legend className={legendClass}>Send me a notification for</legend>
                {kinds.map(({ kind, on }) => (
                  <label key={kind} className="flex min-h-11 items-start gap-3 py-2">
                    <input type="checkbox" name={`kind_${kind}`} defaultChecked={on} className={`${checkBox} mt-0.5`} />
                    <span>
                      <span className="block text-base font-semibold">{KIND_WORDS[kind].label}</span>
                      <span className="block text-sm text-rubric">{KIND_WORDS[kind].help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <p className="max-w-prose text-sm text-rubric">The morning summary follows your choice under Morning summary above.</p>
            <fieldset className={fieldsetClass} data-testid="push-quiet">
              <legend className={legendClass}>Quiet hours</legend>
              <label className={checkRow}>
                <input type="checkbox" name="quietEnabled" defaultChecked={prefs.quietEnabled} className={checkBox} />
                Hold notifications overnight
              </label>
              <div className="mt-2 flex flex-wrap gap-3">
                <div className="min-w-0 flex-1 basis-32">
                  <label htmlFor="quiet-from" className={labelClass}>
                    From
                  </label>
                  <select id="quiet-from" name="quietStartHour" defaultValue={String(prefs.quietStartHour)} className={inputClass}>
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-0 flex-1 basis-32">
                  <label htmlFor="quiet-until" className={labelClass}>
                    Until
                  </label>
                  <select id="quiet-until" name="quietEndHour" defaultValue={String(prefs.quietEndHour)} className={inputClass}>
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="mt-2 flex min-h-11 items-start gap-3 py-2">
                <input type="checkbox" name="urgentIgnoresQuiet" defaultChecked={prefs.urgentIgnoresQuiet} className={`${checkBox} mt-0.5`} />
                <span className="text-base">Let urgent Inbox items through, even in quiet hours</span>
              </label>
              <p className="text-sm text-rubric">Times are St. Louis time. What is held comes as one notification in the morning, or not at all if it is out of date by then.</p>
            </fieldset>
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              Save
            </button>
          </ActionForm>
        </>
      )}
    </Section>
  );
}
