import { referToCorpsAction, setReferralConsentAction, withdrawReferralAction } from "@/app/referral-actions";
import { ActionForm } from "@/components/action-form";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { Section } from "@/components/section";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { instantDate } from "@/lib/format";
import {
  CLOSED_WORDS,
  CONSENT_CHOICES,
  CONSENT_LINES,
  CONSENT_NOW,
  PAST_REFERRALS,
  olderReferralsWords,
  REFER_HELP,
  REFER_INTRO,
  REFER_LABEL,
  REFER_LABELS,
  REFER_PLACEHOLDERS,
  REFER_SECTION,
  REFERRAL_CONSENTS,
  REFERRAL_KIND_WORDS,
  REFERRAL_KINDS,
  REFERRAL_LIMITS,
  referredWords,
  WITHDRAW_EXPLAIN,
  WITHDRAW_LABEL,
  WITHDRAW_TITLE,
} from "@/lib/referral-wording";
import { canReferToCorps, type Actor } from "@/server/access/policy";
import { getDb } from "@/server/db/client";
import { soft } from "@/server/soft";
import { referralsForPerson, type PersonReferrals } from "@/server/volunteers/referrals";

export type ReferralRef = { sfContactId?: string; outsidePersonId?: string };

/** For clergy only: this person's referrals to Mitzvah Corps. Null (nothing shown) for everyone else, or when it could not be read. */
export async function loadReferrals(actor: Actor, ref: ReferralRef): Promise<PersonReferrals | null> {
  if (!canReferToCorps(actor)) return null;
  return soft("Referrals unavailable", null, () => referralsForPerson(getDb(), actor, ref));
}

function ReferForm({ person }: { person: ReferralRef }) {
  return (
    <Sheet label={REFER_LABEL} title={REFER_LABEL} triggerClassName={btnQuiet}>
      <ActionForm action={referToCorpsAction} className="flex flex-col gap-4">
        {person.sfContactId ? <input type="hidden" name="sfContactId" value={person.sfContactId} /> : null}
        {person.outsidePersonId ? <input type="hidden" name="outsidePersonId" value={person.outsidePersonId} /> : null}
        <p className="text-base">
          {REFER_INTRO}{" "}
          <strong className="font-semibold" id="ref-help">
            {REFER_HELP}
          </strong>
        </p>
        <div>
          <label htmlFor="ref-kind" className={labelClass}>
            {REFER_LABELS.kind}
          </label>
          <select id="ref-kind" name="kind" defaultValue="call" className={inputClass}>
            {REFERRAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {REFERRAL_KIND_WORDS[k]}
              </option>
            ))}
          </select>
        </div>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{REFER_LABELS.consent}</legend>
          {REFERRAL_CONSENTS.map((c) => (
            <label key={c} className={checkRow} htmlFor={`ref-consent-${c}`}>
              <input id={`ref-consent-${c}`} type="radio" name="consent" value={c} required className={checkBox} />
              <span>{CONSENT_CHOICES[c]}</span>
            </label>
          ))}
        </fieldset>
        <div>
          <label htmlFor="ref-contact" className={labelClass}>
            {REFER_LABELS.contactLine}
          </label>
          <input id="ref-contact" name="contactLine" maxLength={REFERRAL_LIMITS.contactLine} placeholder={REFER_PLACEHOLDERS.contactLine} className={inputClass} />
        </div>
        <label className={checkRow} htmlFor="ref-address">
          <input id="ref-address" type="checkbox" name="mayShareAddress" className={checkBox} />
          <span>{REFER_LABELS.mayShareAddress}</span>
        </label>
        <div>
          <label htmlFor="ref-involved" className={labelClass}>
            {REFER_LABELS.alreadyInvolved}
          </label>
          <input id="ref-involved" name="alreadyInvolved" maxLength={REFERRAL_LIMITS.alreadyInvolved} placeholder={REFER_PLACEHOLDERS.alreadyInvolved} className={inputClass} aria-describedby="ref-help" />
        </div>
        <div>
          <label htmlFor="ref-note" className={labelClass}>
            {REFER_LABELS.note}
          </label>
          <input id="ref-note" name="note" maxLength={REFERRAL_LIMITS.note} className={inputClass} aria-describedby="ref-help" />
        </div>
        <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
          {REFER_LABEL}
        </button>
      </ActionForm>
    </Sheet>
  );
}

/**
 * On a person's page, for clergy: the open referral with its state and a way to withdraw it, or the short form to
 * refer them; then their closed referrals (the most recent five, and a count of any older) with the line the coordinator left.
 */
export function PersonReferral({ state, person }: { state: PersonReferrals | null; person: ReferralRef }) {
  if (state === null) return null;
  const { open, closed, olderClosed } = state;
  return (
    <Section title={REFER_SECTION}>
      {open ? (
        <div className="mt-2" data-testid="referral-open">
          <p className="text-base font-semibold">{referredWords(instantDate(open.createdAt), open.takenByName)}</p>
          <p className="text-base">
            {REFERRAL_KIND_WORDS[open.kind]}. {CONSENT_LINES[open.consent]}
          </p>
          <div className="mt-2 flex flex-wrap items-start gap-2">
            {open.consent === "rabbi_asks"
              ? (["yes", "coordinator_asks"] as const).map((c) => <ActionButton key={c} action={setReferralConsentAction} fields={{ referralId: open.id, consent: c }} label={CONSENT_NOW[c]} className={btnQuiet} />)
              : null}
            <ConfirmAction action={withdrawReferralAction} fields={{ referralId: open.id }} label={WITHDRAW_LABEL} title={WITHDRAW_TITLE} explain={WITHDRAW_EXPLAIN} confirmLabel={WITHDRAW_LABEL} />
          </div>
        </div>
      ) : (
        <div className="mt-2" data-testid="referral-add">
          <ReferForm person={person} />
        </div>
      )}
      {closed.length > 0 ? (
        <div className="mt-4" data-testid="referral-closed">
          <h3 className="text-sm font-semibold">{PAST_REFERRALS}</h3>
          <ul className="mt-1 flex flex-col gap-1 text-base">
            {closed.map((c) => (
              <li key={c.id}>
                {REFERRAL_KIND_WORDS[c.kind]} · {CLOSED_WORDS[c.closedAs]}, {instantDate(c.closedAt)}
                {[c.note, c.alreadyInvolved, c.contactLine].filter(Boolean).map((line, i) => (
                  <span key={i} className="block break-words">
                    {line}
                  </span>
                ))}
                {c.outcomeLine ? <span className="block break-words text-rubric">{c.outcomeLine}</span> : null}
              </li>
            ))}
          </ul>
          {olderClosed > 0 ? (
            <p className="mt-1 text-sm text-rubric" data-testid="referral-older">
              {olderReferralsWords(olderClosed)}
            </p>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
