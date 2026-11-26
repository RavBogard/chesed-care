import { acceptProposalAction, dismissProposalAction, keepToClergyAction, readAgainAction, releaseProposalAction } from "@/app/inbox-actions";
import { CATEGORY_LABEL, type CategoryKey } from "@/lib/care-labels";
import { markEvidence } from "@/lib/evidence";
import { instantDate, monthDay } from "@/lib/format";
import { VOLUNTEER_FLAG_LABEL, type Intake } from "@/server/care/intake";
import type { Proposal } from "@/server/care/proposals";
import { ActionForm } from "./action-form";
import { AddToAgenda } from "./agenda/add-to-agenda";
import type { TeamChoice } from "./care-fields";
import { ActionButton, ConfirmAction } from "./confirm-sheet";
import { DecisionForm, type DecisionInitial } from "./decision-form";
import type { JourneyOption } from "./journey-picker";
import { LockIcon } from "./lock-icon";
import type { PersonChoice } from "./person-picker";
import { Sheet } from "./sheet";
import { btnPrimary, btnQuiet, cardClass, inputClass, labelClass, tagNew, tagQuiet, tagRestricted, titleClass } from "./ui";

export const CHANNEL_LABEL: Record<Proposal["channel"], string> = {
  clergy: "Written in the app",
  capture: "Quick capture",
  connector: "Told to Claude",
  email: "Email",
  form: "Public form",
  staff: "Staff report",
  voice: "Dictation",
  salesforce: "Salesforce",
  shortcut: "iPhone Shortcut",
};

/** What the page worked out about one proposal: who it names, what that person already has, who is suggested. */
export type InboxEntry = {
  proposal: Proposal;
  person: PersonChoice | null;
  candidates: PersonChoice[];
  existing: { id: string; category: string }[];
  /** What the matching step found for each name the AI reading wrote down, worked out for this viewer when the page was drawn. */
  nameMatches: { name: string; state: "one" | "ambiguous" | "none"; chosenName: string | null; candidateCount: number }[];
  /** The card has names the AI reading wrote down but they are not matched yet (a long list matches the newest first). */
  matchPending: boolean;
  /** Clergy may ask for a proposal that has no reading to be read again. */
  canReread: boolean;
  suggestedOwnerName: string | null;
  own: boolean;
  /** What a public sender or Salesforce stated, when there is any. */
  intake: Intake | null;
  /**
   * A volunteer's flag on a task for a care item the viewer may open. Restricted: it can only be added to that item
   * (the server refuses anything else). `label` is null when that item cannot take it (closed, or unreadable now).
   */
  scope?: { careItemId: string; restricted: boolean; label: { displayName: string; category: string } | null } | null;
};

const URGENCY_LABEL: Record<string, string> = { now: "Right now", today: "Today", week: "This week", routine: "No rush" };
const FIELD_LABEL: Record<string, string> = { names: "Who", summary: "What is going on", category: "Kind", urgency: "How soon", dates: "Dates", sensitive: "Looks sensitive", followUp: "First follow-up" };

const ANSWER: Record<string, string> = { yes: "Yes", no: "No", not_sure: "Not sure" };

const Row = ({ term, children }: { term: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
    <dt className="shrink-0 text-sm font-semibold text-rubric sm:w-36">{term}</dt>
    <dd className="min-w-0 break-words text-base">{children}</dd>
  </div>
);

/** The sheet's starting values: the reading, where there is one. */
export function initialFor(entry: InboxEntry): DecisionInitial {
  const r = entry.proposal.reading;
  // A flag on a task for an open (unrestricted) care item starts as an addition to that item; the usual choices stay.
  const scoped = entry.scope?.label ? { id: entry.scope.careItemId, category: entry.scope.label.category } : null;
  if (scoped) {
    return {
      person: entry.person,
      candidates: entry.candidates,
      existing: [scoped, ...entry.existing.filter((i) => i.id !== scoped.id)],
      existingCareItemId: scoped.id,
      summary: r?.summary,
      followUp: r?.followUp ?? null,
      followUpIdea: r?.followUp ? undefined : r?.followUpIdea,
    };
  }
  return {
    person: entry.person,
    candidates: entry.candidates,
    existing: entry.existing,
    // With the app's own reading, one open item the viewer can see for this person is offered as the place to add this, instead of a second item.
    // A reading that looks sensitive never defaults to adding to an open item (which may be readable by more people): it starts as a new, restricted one.
    existingCareItemId:
      r?.restrictedSuggested === true
        ? undefined
        : r?.existingCareItemId && entry.existing.some((i) => i.id === r.existingCareItemId)
          ? r.existingCareItemId
          : r?.by === "app_ai" && entry.existing.length === 1
            ? entry.existing[0].id
            : undefined,
    category: r?.category,
    summary: r?.summary,
    location: r?.location,
    ownerUserId: r?.ownerUserId,
    restricted: r?.restrictedSuggested === true,
    followUp: r?.followUp ?? null,
    followUpIdea: r?.followUp ? undefined : r?.followUpIdea,
    journey: journeyFor(entry),
    miSheberach: miSheberachFor(entry),
  };
}

/**
 * The Mi Sheberach offer: only for a public-form proposal, by what the sender answered. "Yes" is offered
 * ticked, "not sure" unticked, "no" not at all. The name is the person it is about (or the name typed on
 * the form); who asked is filled in only when the sender agreed we may say they told us.
 */
export function miSheberachFor(entry: InboxEntry): DecisionInitial["miSheberach"] {
  const answer = entry.proposal.miSheberachAnswer;
  if (answer !== "yes" && answer !== "not_sure") return undefined;
  const pub = entry.intake?.kind === "public_form" ? entry.intake : null;
  const name = entry.person?.name ?? pub?.about ?? "";
  const askedBy = pub && entry.proposal.mayTellThem === "yes" && pub.sender.trim() ? `added by ${pub.sender.trim()}` : "";
  return { offer: answer, name, askedBy };
}

/**
 * The journey the accept sheet offers. A death or a birth Salesforce reports: the bereavement
 * year (from the date of death) or the new-baby journey, chosen. A reading that says
 * bereavement or a birth: only suggested, never chosen for the reader.
 */
function journeyFor(entry: InboxEntry): DecisionInitial["journey"] {
  const intake = entry.intake?.kind === "salesforce" ? entry.intake : null;
  if (intake?.event === "death") return { key: "bereavement_year", on: true, anchorDate: intake.deathDate ?? undefined };
  if (intake?.event === "birth") return { key: "new_baby", on: true };
  const category = entry.proposal.reading?.category;
  if (category === "bereavement") return { key: "bereavement_year", on: false };
  if (category === "birth") return { key: "new_baby", on: false };
  return undefined;
}

/** One proposal. Accept takes the reading as it stands when it names a person and a kind and is not sensitive; otherwise Accept opens Edit. */
export function InboxCard({ entry, today, actorId, holders, journeyChoices = [] }: { entry: InboxEntry; today: string; actorId: string; holders: TeamChoice[]; journeyChoices?: JourneyOption[] }) {
  const p = entry.proposal;
  const r = p.reading;
  const label = (c: string | undefined) => (c ? (CATEGORY_LABEL[c as CategoryKey] ?? c) : null);
  const initial = initialFor(entry);
  const sensitive = r?.restrictedSuggested === true;
  // The app's own reading is a suggestion: Accept always opens the sheet to check it, never saves in one tap.
  const ready = r?.by !== "app_ai" && entry.person !== null && !sensitive && (initial.existingCareItemId ? !!r?.summary : !!r?.category);
  // With no submitter, the stored label says where it came from ("A volunteer"), unless the channel already says so ("Public form", "Staff report").
  const sourceLabel = !p.submittedBy && p.submitterName && !CHANNEL_LABEL[p.channel].toLowerCase().includes(p.submitterName.toLowerCase()) ? p.submitterName : null;
  const from = entry.own ? "You" : p.submittedBy ? (p.submitterName ?? "Someone") : sourceLabel;
  const pub = entry.intake?.kind === "public_form" ? entry.intake : null;
  // Unverified: what a public sender stated, and a volunteer's flag (as the connector says too). A decided public report put back in the Inbox has lost its intake, so says nothing either way.
  const unverified = !!pub || (!p.submittedBy && p.channel === "form" && p.submitterName === VOLUNTEER_FLAG_LABEL);
  const editor = (title: string, trigger: string, triggerClass: string) => (
    <Sheet label={trigger} title={title} triggerClassName={triggerClass}>
      <DecisionForm proposalId={p.id} words={p.rawText} today={today} actorId={actorId} holders={holders} initial={initial} submitLabel="Save to the care list" journeyChoices={journeyChoices} />
    </Sheet>
  );
  return (
    <li className={cardClass} data-testid="inbox-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={titleClass}>{unverified ? <span className="text-alert">Unverified: </span> : null}
          {entry.person?.name ?? pub?.about ?? "Someone, not yet matched"}
        </h2>
        <p className="text-sm text-rubric">
          {from ? `${from} · ` : ""}
          {CHANNEL_LABEL[p.channel]} · {instantDate(p.createdAt)}
        </p>
      </div>
      {pub ? (
        <div className="mt-2" data-testid="inbox-public">
          <span className={tagNew}>Unverified · from the public form</span>
          <dl className="mt-2 flex flex-col gap-2">
            <Row term="About">{pub.about}</Row>
            <Row term="Sent by">{pub.sender}</Row>
            <Row term="How to reach them">
              <span className="[overflow-wrap:anywhere]">{pub.contact}</span>
            </Row>
            <Row term="May we tell them">{p.mayTellThem ? (ANSWER[p.mayTellThem] ?? p.mayTellThem) : "Not asked"}</Row>
            <Row term="Mi Sheberach list">{p.miSheberachAnswer ? (ANSWER[p.miSheberachAnswer] ?? p.miSheberachAnswer) : "Not asked"}</Row>
          </dl>
          <p className="mt-2 text-sm text-rubric">Everything above is as the sender typed it. Nothing has been checked against our records.</p>
          {p.practical ? (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="inbox-practical">
              {p.leadVisible ? <span className={tagQuiet}>Mitzvah Corps can see this</span> : <span className={tagQuiet}>Practical help asked: clergy only</span>}
              {p.leadVisible && p.takenByName ? <span className={tagQuiet}>Taken by {p.takenByName} (Mitzvah Corps)</span> : null}
              {p.leadVisible ? (
                <ActionButton action={keepToClergyAction} fields={{ proposalId: p.id }} label="Keep this to clergy" className={btnQuiet} showOk={false} />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {entry.own ? <p className="mt-1 text-sm text-rubric">Your own note. Only you see it until you send it to the Inbox.</p> : null}

      {p.rawText ? (
        <details className="mt-3">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-action underline underline-offset-4">Their words</summary>
          <blockquote className="mt-1 whitespace-pre-wrap break-words rounded-md bg-tint p-3 text-base" data-testid="inbox-words">
            {r?.evidence?.length
              ? markEvidence(
                  p.rawText,
                  r.evidence.map((e) => e.text),
                ).map((piece, i) =>
                  piece.marked ? (
                    <mark key={i} className="rounded-sm bg-alert-band px-0.5 text-ink">
                      {piece.text}
                    </mark>
                  ) : (
                    piece.text
                  ),
                )
              : p.rawText}
          </blockquote>
        </details>
      ) : null}

      {r ? (
        <dl className="mt-3 flex flex-col gap-2" data-testid="inbox-reading">
          {r.by === "app_ai" ? (
            <p className="text-sm text-rubric" data-testid="inbox-ai-label">
              {pub ? "A suggestion from the app’s AI reading of an unverified message from the public form. Check it before you accept." : "A suggestion from the app’s AI reading. Check it before you accept."}
            </p>
          ) : null}
          {r.urgency ? <Row term="How soon">{URGENCY_LABEL[r.urgency] ?? r.urgency}</Row> : null}
          {r.dates?.length ? <Row term="Dates">{r.dates.map((d) => `${d.label}, ${monthDay(d.date)}`).join("; ")}</Row> : null}
          {r.followUpIdea && !r.followUp ? <Row term="Suggested follow-up">{r.followUpIdea}</Row> : null}
          {sensitive ? (
            <div>
              <span className={tagRestricted}>
                <LockIcon /> Looks sensitive
              </span>
            </div>
          ) : null}
          {r.category ? <Row term="Kind">{label(r.category)}</Row> : null}
          {r.summary ? <Row term="What is going on">{r.summary}</Row> : null}
          {r.location ? <Row term="Where">{r.location}</Row> : null}
          {entry.suggestedOwnerName ? <Row term="Suggested owner">{entry.suggestedOwnerName}</Row> : null}
          {r.followUp ? (
            <Row term="First follow-up">
              {r.followUp.title}, {monthDay(r.followUp.dueDate)}
            </Row>
          ) : null}
          {!entry.person && r.person?.name ? <Row term="Named">{r.person.name}</Row> : null}
          {entry.matchPending && r.names?.length ? (
            <Row term="Who">
              <a href={`/inbox?match=${p.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-action underline underline-offset-4">
                Open to match
              </a>
            </Row>
          ) : null}
          {entry.nameMatches.length > 0 ? (
            <div className="flex flex-col gap-2" data-testid="inbox-matches">
              {entry.nameMatches.map((m) => (
                <Row key={m.name} term={m.name}>
                  {m.state === "one" ? `Matched to ${m.chosenName}` : m.state === "ambiguous" ? `Could be any of ${m.candidateCount}: pick one when you accept` : "Nobody found. You can add them as someone outside the directory."}
                </Row>
              ))}
            </div>
          ) : null}
          {r.evidence?.length ? (
            <details data-testid="inbox-evidence">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-action underline underline-offset-4">Which words led to this</summary>
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {r.evidence.map((e, i) => (
                  <li key={i}>
                    <span className="font-semibold text-rubric">{FIELD_LABEL[e.field] ?? e.field}: </span>
                    <q className="break-words">{e.text}</q>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {entry.existing.length > 0 ? (
            <Row term="Already on the list">
              <span className={tagQuiet}>{entry.existing.length === 1 ? "Has an open care item" : `${entry.existing.length} open care items`}</span>
            </Row>
          ) : null}
        </dl>
      ) : null}

      {entry.canReread ? (
        <div className="mt-3">
          <ActionButton action={readAgainAction} fields={{ proposalId: p.id }} label="Read it again" className={btnQuiet} showOk={false} />
        </div>
      ) : null}

      {entry.scope?.restricted ? (
        <div className="mt-4 flex flex-wrap items-start gap-2" data-testid="inbox-scoped">
          {entry.scope.label ? <AddToScopedItem proposalId={p.id} careItemId={entry.scope.careItemId} label={entry.scope.label} summary={r?.summary ?? ""} /> : null}
          <DismissProposal proposalId={p.id} />
        </div>
      ) : (
      <div className="mt-4 flex flex-wrap items-start gap-2">
        {entry.person ? <AddToAgenda about={entry.person.name} {...(entry.person.kind === "sf" ? { sfContactId: entry.person.contactId } : { outsidePersonId: entry.person.id })} displayName={entry.person.name} idPrefix={`agenda-${p.id}`} /> : null}
        {ready ? (
          <ActionForm action={acceptProposalAction} showOk={false}>
            <input type="hidden" name="proposalId" value={p.id} />
            {entry.person?.kind === "sf" ? <input type="hidden" name="contactId" value={entry.person.contactId} /> : null}
            {entry.person?.kind === "outside" ? <input type="hidden" name="outsidePersonId" value={entry.person.id} /> : null}
            {initial.existingCareItemId ? <input type="hidden" name="careItemId" value={initial.existingCareItemId} /> : <input type="hidden" name="category" value={r?.category ?? "other"} />}
            <input type="hidden" name="summary" value={r?.summary ?? ""} />
            <input type="hidden" name="location" value={r?.location ?? ""} />
            {r?.ownerUserId ? <input type="hidden" name="ownerUserId" value={r.ownerUserId} /> : null}
            {r?.followUp ? (
              <>
                <input type="hidden" name="followUpTitle" value={r.followUp.title} />
                <input type="hidden" name="followUpDue" value={r.followUp.dueDate} />
              </>
            ) : null}
            <button type="submit" className={btnPrimary}>
              Accept
            </button>
          </ActionForm>
        ) : (
          editor(entry.person ? `Accept: ${entry.person.name}` : "Accept: who is it about?", "Accept", btnPrimary)
        )}
        {editor(entry.person ? `Edit: ${entry.person.name}` : "Edit", "Edit", btnQuiet)}
        <DismissProposal proposalId={p.id} />
        {entry.own ? (
          <ActionButton action={releaseProposalAction} fields={{ proposalId: p.id }} label="Send to the Inbox for someone else" className={btnQuiet} showOk={false} />
        ) : null}
      </div>
      )}
    </li>
  );
}

function DismissProposal({ proposalId }: { proposalId: string }) {
  return (
    <ConfirmAction
      action={dismissProposalAction}
      fields={{ proposalId }}
      label="Dismiss"
      title="Dismiss this?"
      explain="It is closed without action. The words are kept for the rabbis, under Closed without action, at the foot of the Inbox. Whoever sent it will see that it was closed without action."
      confirmLabel="Dismiss"
    />
  );
}

/**
 * A volunteer's flag on a task for a RESTRICTED care item: it can only be added to that same item (the server refuses
 * anything else), so its kept words stay with the people the item is open to. No agenda, no new item, no other person.
 */
function AddToScopedItem({ proposalId, careItemId, label, summary }: { proposalId: string; careItemId: string; label: { displayName: string; category: string }; summary: string }) {
  const kind = (CATEGORY_LABEL[label.category as CategoryKey] ?? label.category).toLowerCase();
  const title = `Add to the ${kind} care for ${label.displayName}`;
  return (
    <Sheet label={title} title={title} triggerClassName={btnPrimary}>
      <ActionForm action={acceptProposalAction} className="flex flex-col gap-4">
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="careItemId" value={careItemId} />
        <div>
          <label htmlFor={`scoped-${proposalId}`} className={labelClass}>
            What to add
          </label>
          <textarea id={`scoped-${proposalId}`} name="summary" rows={3} maxLength={500} required defaultValue={summary} className={`${inputClass} py-2`} />
        </div>
        <button type="submit" className={btnPrimary}>
          Save
        </button>
      </ActionForm>
    </Sheet>
  );
}
