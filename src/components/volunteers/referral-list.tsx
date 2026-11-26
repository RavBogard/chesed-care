import { closeReferralAction, takeReferralAction } from "@/app/referral-actions";
import { ActionForm } from "@/components/action-form";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { Section } from "@/components/section";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, inputClass, labelClass, nameClass, tagNew, tagQuiet } from "@/components/ui";
import { instantDate } from "@/lib/format";
import {
  ADDRESS_WORDS,
  CONSENT_LINES,
  DECLINED_EXPLAIN,
  DECLINED_LABEL,
  DECLINED_TITLE,
  DONE_CONFIRM,
  DONE_LABEL,
  DONE_TITLE,
  OUTCOME_HELP,
  OUTCOME_LABEL,
  REFERRAL_KIND_WORDS,
  REFERRAL_LIMITS,
  REFERRALS_SECTION,
  referredByWords,
  SHOWN_LABELS,
  TAKE_LABEL,
} from "@/lib/referral-wording";
import type { OpenReferral } from "@/server/volunteers/referrals";

const list = "mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface";

function Line({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <p className="mt-1 break-words text-base">
      <span className="font-semibold">{label}:</span> {value}
    </p>
  );
}

/**
 * "Referred by the rabbis" on the coordinator's home: each open referral with what a volunteer needs and nothing
 * about why. The name is plain text: there is no way from here to a person's page or a care record.
 */
export function ReferralList({ referrals }: { referrals: OpenReferral[] }) {
  return (
    <Section title={REFERRALS_SECTION}>
      <ul className={list} data-testid="home-referrals">
        {referrals.map((r) => (
          <li key={r.id} className="px-4 py-3" data-testid="home-referral">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className={`${nameClass} min-w-0 break-words`}>{r.name}</h3>
              {r.takenByName === null ? <span className={tagNew}>Nobody yet</span> : <span className={tagQuiet}>Taken by {r.takenByName}</span>}
            </div>
            <p className="text-base">{REFERRAL_KIND_WORDS[r.kind]}</p>
            <p className={`mt-1 text-base ${r.consent === "yes" ? "" : "font-semibold"}`} data-testid="referral-consent">
              {CONSENT_LINES[r.consent]}
            </p>
            <Line label={SHOWN_LABELS.contactLine} value={r.contactLine} />
            <p className="mt-1 text-base">{r.mayShareAddress ? ADDRESS_WORDS.yes : ADDRESS_WORDS.no}</p>
            <Line label={SHOWN_LABELS.alreadyInvolved} value={r.alreadyInvolved} />
            <Line label={SHOWN_LABELS.note} value={r.note} />
            <p className="mt-1 text-sm text-rubric">{referredByWords(r.referredByName, instantDate(r.createdAt))}</p>
            {r.canTake || r.takenByMe ? (
              <div className="mt-2 flex flex-wrap items-start gap-2">
                {r.canTake ? <ActionButton action={takeReferralAction} fields={{ referralId: r.id }} label={TAKE_LABEL} ariaLabel={`${TAKE_LABEL}: ${r.name}`} className={btnPrimary} showOk={false} /> : null}
                {r.takenByMe ? (
                  <>
                    <Sheet label={DONE_LABEL} ariaLabel={`${DONE_LABEL}: ${r.name}`} title={DONE_TITLE} triggerClassName={btnPrimary}>
                      <ActionForm action={closeReferralAction} className="flex flex-col gap-4">
                        <input type="hidden" name="referralId" value={r.id} />
                        <input type="hidden" name="as" value="done" />
                        <div>
                          <label htmlFor={`ref-outcome-${r.id}`} className={labelClass}>
                            {OUTCOME_LABEL}
                          </label>
                          <input id={`ref-outcome-${r.id}`} name="outcome" maxLength={REFERRAL_LIMITS.outcomeLine} className={inputClass} aria-describedby={`ref-outcome-help-${r.id}`} />
                          <p id={`ref-outcome-help-${r.id}`} className="mt-1 text-sm text-rubric">
                            {OUTCOME_HELP}
                          </p>
                        </div>
                        <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                          {DONE_CONFIRM}
                        </button>
                      </ActionForm>
                    </Sheet>
                    <ConfirmAction action={closeReferralAction} fields={{ referralId: r.id, as: "declined" }} label={DECLINED_LABEL} ariaLabel={`${DECLINED_LABEL}: ${r.name}`} title={DECLINED_TITLE} explain={DECLINED_EXPLAIN} confirmLabel={DECLINED_LABEL} />
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
