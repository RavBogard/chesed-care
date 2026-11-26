import Link from "next/link";
import { dismissProposalAction } from "@/app/inbox-actions";
import { quickAcceptAction } from "@/app/bring-in-actions";
import type { QuickMatch } from "@/server/care/bring-in";
import { LAST_CONTACT_LABEL } from "@/lib/bring-in-wording";
import { CATEGORY_LABEL, type CategoryKey } from "@/lib/care-labels";
import { ActionForm } from "./action-form";
import type { TeamChoice } from "./care-fields";
import { ConfirmAction } from "./confirm-sheet";
import { DecisionForm } from "./decision-form";
import { initialFor, type InboxEntry } from "./inbox-card";
import type { JourneyOption } from "./journey-picker";
import { LockIcon } from "./lock-icon";
import { ReviewKeys } from "./review-keys";
import { Sheet } from "./sheet";
import { btnPrimary, btnQuiet, cardClass, checkBox, checkRow, inputClass, labelClass, tagQuiet, tagRestricted, titleClass } from "./ui";

type Props = {
  entry: InboxEntry;
  quick: QuickMatch | null;
  position: number;
  total: number;
  left: number;
  skipHref: string;
  today: string;
  actorId: string;
  holders: TeamChoice[];
  journeyChoices: JourneyOption[];
};

/**
 * One entry of the list being checked, large. The primary button accepts with the reading's values
 * in one tap when the server found a single strong match (`quick`); otherwise it opens the same
 * sheet the Inbox uses. Enter presses it, S skips.
 */
export function BringInReview({ entry, quick, position, total, left, skipHref, today, actorId, holders, journeyChoices }: Props) {
  const p = entry.proposal;
  const r = p.reading;
  const sensitive = r?.restrictedSuggested === true;
  const kind = r?.category ? (CATEGORY_LABEL[r.category as CategoryKey] ?? r.category) : null;
  const match = entry.nameMatches[0];
  const sheet = (
    <DecisionForm proposalId={p.id} words={p.rawText} today={today} actorId={actorId} holders={holders} initial={initialFor(entry)} submitLabel="Save to the care list" journeyChoices={journeyChoices} offerLastContact />
  );
  return (
    <section className={`${cardClass} flex flex-col gap-4`} aria-label="This entry" data-testid="bring-in-review">
      <ReviewKeys skipHref={skipHref} />
      <p className="text-sm font-semibold text-rubric tabular-nums" data-testid="bring-in-progress">
        {position} of {total}
        <span className="font-normal"> · {left === 1 ? "1 still to look at" : `${left} still to look at`}</span>
      </p>
      <h2 className={`${titleClass} outline-none`} tabIndex={-1} data-review-heading>
        {entry.person?.name ?? "Someone, not yet matched"}
      </h2>
      {p.rawText ? (
        <blockquote className="whitespace-pre-wrap break-words rounded-md bg-tint p-3 text-lg" data-testid="bring-in-words">
          {p.rawText}
        </blockquote>
      ) : null}
      {r ? (
        <div className="flex flex-col gap-2" data-testid="bring-in-reading">
          <p className="text-sm text-rubric">A suggestion from the app&rsquo;s AI reading. Check it before you accept.</p>
          {sensitive ? (
            <div>
              <span className={tagRestricted}>
                <LockIcon /> Looks sensitive
              </span>
            </div>
          ) : null}
          {kind ? (
            <p className="text-base">
              <span className="font-semibold text-rubric">Kind: </span>
              {kind}
            </p>
          ) : null}
          {r.summary ? (
            <p className="text-base">
              <span className="font-semibold text-rubric">What is going on: </span>
              {r.summary}
            </p>
          ) : null}
          {match ? (
            <p className="text-base" data-testid="bring-in-match">
              <span className="font-semibold text-rubric">{match.name}: </span>
              {match.state === "one" ? `matched to ${match.chosenName}` : match.state === "ambiguous" ? `could be any of ${match.candidateCount}; you pick when you accept` : "nobody found; you can add them as someone outside the directory"}
            </p>
          ) : null}
          {entry.existing.length > 0 ? (
            <p>
              <span className={tagQuiet}>{entry.existing.length === 1 ? "Already has an open care item" : `Already has ${entry.existing.length} open care items`}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-rubric">No reading yet. Accept opens the form so you can say who this is.</p>
      )}

      {quick ? (
        <ActionForm action={quickAcceptAction} showOk={false} className="flex flex-col gap-3">
          <input type="hidden" name="proposalId" value={p.id} />
          <div className="rounded-md border border-rule p-3" data-testid="review-match-card">
            <p className="text-sm font-semibold text-rubric">Is this the person?</p>
            <p className="font-serif text-lg font-bold leading-snug">{quick.name}</p>
            <p className="text-base">{[quick.member ? "Member household" : "Not in the directory", quick.household, quick.place].filter(Boolean).join(" · ")}</p>
            <p className="mt-1 text-sm text-rubric">The care team will be able to see this.</p>
          </div>
          <div>
            <label htmlFor="rev-last" className={labelClass}>
              Last contact was about
            </label>
            <select id="rev-last" name="lastContact" defaultValue="unsure" className={inputClass} data-testid="review-last-contact">
              {(Object.keys(LAST_CONTACT_LABEL) as (keyof typeof LAST_CONTACT_LABEL)[]).map((k) => (
                <option key={k} value={k}>
                  {LAST_CONTACT_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          {journeyChoices.some((j) => j.key === "standing") ? (
            <label className={checkRow}>
              <input type="checkbox" name="checkIn" className={checkBox} />
              <span>Keep in touch every 4 weeks</span>
            </label>
          ) : null}
          <div>
            <button type="submit" data-review-primary className={`${btnPrimary} w-full sm:w-auto sm:min-w-44`}>
              Yes, this is {quick.name}
            </button>
          </div>
        </ActionForm>
      ) : (
        <div data-review-primary-wrap className="contents">
          <Sheet label="Accept" title={entry.person ? `Accept: ${entry.person.name}` : "Accept: who is it about?"} triggerClassName={`${btnPrimary} w-full sm:w-auto sm:min-w-44`}>
            {sheet}
          </Sheet>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-2 border-t border-rule pt-3">
        {quick ? (
          <Sheet label="Edit" title={`Edit: ${entry.person?.name ?? "this entry"}`} triggerClassName={btnQuiet}>
            {sheet}
          </Sheet>
        ) : null}
        <Link href={skipHref} scroll={false} className={btnQuiet}>
          Skip for now
        </Link>
        <ConfirmAction action={dismissProposalAction} fields={{ proposalId: p.id }} label="Not a care item" title="Not a care item?" explain="It is closed without action. The words are kept for the rabbis." confirmLabel="Not a care item" />
      </div>
      <p className="text-sm text-rubric">Keys: Enter accepts, S skips.</p>
    </section>
  );
}
