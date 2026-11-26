import Link from "next/link";
import { deleteContactAction, pauseCareItemAction, reopenCareItemAction, resumeCareItemAction, closeCareItemAction, updateCareItemAction, updateContactAction } from "@/app/care-actions";
import { CATEGORY_LABEL, OUTCOME_KEYS, OUTCOME_LABEL, statusLabel, type OutcomeKey } from "@/lib/care-labels";
import { dueLabel, instantDate, monthDay } from "@/lib/format";
import { ADD_TO_LIST, asksAboutMiSheberach, CLOSED_PROMPT } from "@/lib/misheberach-wording";
import type { EntryView } from "@/server/misheberach/list";
import { canChangeRestriction, canManageCareItems, canManageMealPages, isClergyLevel, type Actor } from "@/server/access/policy";
import type { CareItem, CareItemStub } from "@/server/care/care-items";
import type { ContactEntry } from "@/server/care/contact-log";
import type { OriginalReport } from "@/server/care/original-reports";
import type { FollowUp } from "@/server/care/follow-ups";
import type { TeamMember } from "@/server/care/users";
import { isPausedCareItem } from "@/server/care/status";
import { addDays } from "@/server/lifecycle/window";
import { runningKeys, type JourneyChoice, type JourneyView } from "@/server/journeys/journeys";
import { ActionForm } from "./action-form";
import { AddToAgenda } from "./agenda/add-to-agenda";
import { THANK_WORDS } from "@/lib/clergy-wording";
import { thankYouMailto } from "@/lib/thank-you";
import { CareFields, type TeamChoice } from "./care-fields";
import { CorpsNote } from "./corps-note";
import { ItemJourneys, StartJourney } from "./care-journeys";
import { CHANNEL_LABEL } from "./inbox-card";
import { ActionButton, ConfirmAction } from "./confirm-sheet";
import { EndEntry } from "./misheberach/entry-forms";
import { FollowUpControls } from "./follow-up-controls";
import { LockIcon } from "./lock-icon";
import { Section } from "./section";
import { Sheet } from "./sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, btnText, cardClass, checkBox, inputClass, labelClass, tagNew, tagQuiet, tagRestricted, titleClass } from "./ui";
import { holdersOf } from "@/components/holders";

/** What the care part of a person's page needs, the same for a person in Salesforce and one who is not. */
export type CareView = {
  today: string;
  name: string;
  careItems: CareItem[];
  restrictedCare: CareItemStub[];
  followUps: FollowUp[];
  contacts: ContactEntry[];
  team: TeamMember[];
  /** The clergy named on each restricted item the actor holds (only theirs are known to them). */
  access: Record<string, string[]>;
  /** The journeys on these care items (clergy level), and the journeys that can be started. */
  journeys?: JourneyView[];
  journeyChoices?: JourneyChoice[];
  /** Clergy only: the live Mi Sheberach entries for this person, and for the care items the viewer fully sees. */
  miSheberach?: { person: EntryView[]; items: EntryView[] };
  /** Clergy: who told us about each care item the viewer fully sees, when the sender agreed we may say so (public form, accepted). */
  reporters?: Record<string, { name: string; email: string }>;
  /** Clergy: the words of the reports behind each care item, as they arrived, for the items the viewer may read them on (src/server/care/original-reports.ts). */
  originalReports?: Record<string, OriginalReport[]>;
};

const KIND = { call: "Call", visit: "Visit", text: "Text", other: "Contact" } as const;

const dl = "mt-2 flex flex-col gap-1";
const Fact = ({ term, children }: { term: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
    <dt className="shrink-0 text-sm font-semibold text-rubric sm:w-36">{term}</dt>
    <dd className="min-w-0 break-words text-base">{children}</dd>
  </div>
);

/** A restricted item the viewer cannot read: only that someone has this person in their care. No link, no detail. */
export function RestrictedStub({ stub }: { stub: CareItemStub }) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-rule-soft bg-surface px-4 py-3 text-base text-rubric" data-testid="restricted-stub">
      <LockIcon />
      <span>In {stub.ownerName ?? "a colleague"}&rsquo;s care</span>
    </li>
  );
}

/** One follow-up. Inside a care item it is a ruled line of that card; on its own (`boxed`) it is a card. */
function FollowUpLine({ f, view, actor, holders, boxed = false }: { f: FollowUp; view: CareView; actor: Actor; holders: TeamChoice[]; boxed?: boolean }) {
  const owner = view.team.find((t) => t.id === f.ownerUserId);
  const ownerName = owner ? (owner.id === actor.id ? "You" : (owner.name ?? owner.email)) : null;
  return (
    <li className={boxed ? cardClass : "border-t border-rule-soft pt-3"} data-testid="follow-up-row">
      <p className="text-base">{f.title}</p>
      <p className={`text-sm ${f.dueDate < view.today ? "font-semibold text-alert" : "text-rubric"}`}>
        {dueLabel(view.today, f.dueDate)}
        {ownerName ? ` · ${ownerName}` : ""}
        {f.forLead ? " · for Mitzvah Corps" : ""}
      </p>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <FollowUpControls f={f} who={view.name} canEdit={isClergyLevel(actor)} holders={holders} actorId={actor.id} />
        {isClergyLevel(actor) && asksAboutMiSheberach(f) ? (
          <Link href={`/mi-sheberach/new?careItem=${f.careItemId}`} className={btnQuiet}>
            {ADD_TO_LIST}
          </Link>
        ) : null}
        {f.link === "meals" && f.careItemId && canManageMealPages(actor) ? (
          <Link href={`/meals/new?careItem=${f.careItemId}`} className={btnQuiet}>
            Start a Mitzvah Meals page
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/** Whether the person is on the Mi Sheberach list (by this care item or as a person), or a way to add them. Shown only to clergy who fully see the item. */
function MiSheberachLine({ item, view }: { item: CareItem; view: CareView }) {
  const on = view.miSheberach?.items.find((e) => e.careItemId === item.id) ?? view.miSheberach?.person[0];
  if (on) {
    return (
      <p className="mt-2 text-sm text-rubric" data-testid="care-item-mi-sheberach">
        On the Mi Sheberach list since {monthDay(on.dateAdded)}
        {on.kind === "standing" ? ", until further notice" : ""}.
      </p>
    );
  }
  if (item.status === "closed") return null;
  return (
    <p className="mt-2">
      <Link href={`/mi-sheberach/new?careItem=${item.id}`} className={btnText} data-testid="care-item-mi-add">
        Add to Mi Sheberach
      </Link>
    </p>
  );
}

/** "Original report": the words a report arrived with, collapsed. Plain text only; the server decides who gets any (clergy who may). */
function OriginalReports({ reports }: { reports: OriginalReport[] | undefined }) {
  if (!reports?.length) return null;
  return (
    <details className="mt-2" data-testid="original-report">
      <summary className={`${btnText} cursor-pointer`}>{reports.length === 1 ? "Original report" : `Original reports (${reports.length})`}</summary>
      <ul className="mt-1 flex flex-col gap-2">
        {reports.map((r) => (
          <li key={r.proposalId}>
            <p className="text-sm text-rubric">
              {CHANNEL_LABEL[r.channel]} · {instantDate(r.receivedAt)}
            </p>
            <blockquote className="mt-1 whitespace-pre-wrap break-words rounded-md bg-tint p-3 text-base text-ink">{r.words}</blockquote>
          </li>
        ))}
      </ul>
    </details>
  );
}

function CareItemCard({ item, view, actor, holders }: { item: CareItem; view: CareView; actor: Actor; holders: TeamChoice[] }) {
  const manage = canManageCareItems(actor);
  const owner = view.team.find((t) => t.id === item.ownerUserId);
  const ownerName = owner ? (owner.id === actor.id ? "You" : (owner.name ?? owner.email)) : null;
  const mine = view.followUps.filter((f) => f.careItemId === item.id && !f.doneAt);
  const paused = isPausedCareItem(item, view.today);
  const status = statusLabel(item, view.today);
  const ownsRestriction = canChangeRestriction(actor, item);
  // The current holder stays a choice even when they can no longer hold new work.
  const choices = holders.some((h) => h.id === item.ownerUserId) ? holders : [...holders, { id: item.ownerUserId, name: ownerName ?? "Current holder", stale: true }];
  return (
    <li className={cardClass} data-testid="care-item">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className={titleClass}>{CATEGORY_LABEL[item.category]}</h3>
        <span className={item.status === "new" ? tagNew : tagQuiet} data-testid="care-status">
          {status}
        </span>
        {item.restricted ? (
          <span className={tagRestricted} data-testid="restricted-mark">
            <LockIcon /> Restricted
          </span>
        ) : null}
      </div>
      <p className="text-sm text-rubric">With {ownerName ?? "no one"}</p>
      {item.summary || item.location || item.learnedFrom ? (
        <dl className={dl}>
          {item.summary ? <Fact term="What is going on">{item.summary}</Fact> : null}
          {item.location ? <Fact term="Where">{item.location}</Fact> : null}
          {item.learnedFrom ? <Fact term="How we learned">{item.learnedFrom}</Fact> : null}
        </dl>
      ) : null}
      {view.reporters?.[item.id] ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 text-base" data-testid="told-by">
          <span className="min-w-0 break-words">
            {THANK_WORDS.toldBy} {view.reporters[item.id].name}
          </span>
          <a href={thankYouMailto(view.reporters[item.id].email)} className={btnText} data-testid="thank-them" aria-describedby={`thank-hint-${item.id}`}>
            {THANK_WORDS.thank}
          </a>
          <span id={`thank-hint-${item.id}`} className="sr-only">
            {THANK_WORDS.hint}
          </span>
        </p>
      ) : null}
      <OriginalReports reports={view.originalReports?.[item.id]} />
      {view.miSheberach && manage ? <MiSheberachLine item={item} view={view} /> : null}
      {mine.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-3">
          {mine.map((f) => (
            <FollowUpLine key={f.id} f={f} view={view} actor={actor} holders={holders} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-rubric">No follow-up is set.</p>
      )}
      {manage ? <CorpsNote item={item} who={view.name} /> : null}
      <ItemJourneys journeys={(view.journeys ?? []).filter((j) => j.careItemId === item.id)} manage={manage} />
      {manage ? (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <AddToAgenda about={`${CATEGORY_LABEL[item.category]}: ${view.name}`} careItemId={item.id} restricted={item.restricted} idPrefix={`agenda-${item.id}`} />
          <Sheet label="Edit" ariaLabel={`Edit the ${CATEGORY_LABEL[item.category].toLowerCase()} care for ${view.name}`} title={`Edit the care for ${view.name}`}>
            <ActionForm action={updateCareItemAction} className="flex flex-col gap-4">
              <input type="hidden" name="careItemId" value={item.id} />
              <CareFields
                idPrefix={`edit-${item.id}`}
                holders={choices}
                actorId={actor.id}
                restrictedControls={ownsRestriction}
                showOwner={!item.restricted || ownsRestriction}
                defaults={{ category: item.category, summary: item.summary ?? "", location: item.location ?? "", learnedFrom: item.learnedFrom ?? "", ownerUserId: item.ownerUserId, restricted: item.restricted, showsCarer: item.restrictedShowsCarer, accessUserIds: view.access[item.id] ?? [] }}
              />
              <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                Save
              </button>
            </ActionForm>
          </Sheet>
          {paused ? (
            <ActionButton action={resumeCareItemAction} fields={{ careItemId: item.id }} label="Resume" className={btnQuiet} showOk={false} />
          ) : (
            <Sheet label="Pause" ariaLabel={`Pause the ${CATEGORY_LABEL[item.category].toLowerCase()} care for ${view.name}`} title={`Pause the care for ${view.name}`}>
              <ActionForm action={pauseCareItemAction} className="flex flex-col gap-4">
                <input type="hidden" name="careItemId" value={item.id} />
                <p className="text-sm text-rubric">It leaves Today and the care list, and comes back on that day by itself.</p>
                <div>
                  <label htmlFor={`pause-${item.id}`} className={labelClass}>
                    Pause until
                  </label>
                  <input id={`pause-${item.id}`} name="pausedUntil" type="date" required min={addDays(view.today, 1)} defaultValue={addDays(view.today, 7)} className={inputClass} />
                </div>
                <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                  Pause
                </button>
              </ActionForm>
            </Sheet>
          )}
          <ConfirmAction
            action={closeCareItemAction}
            fields={{ careItemId: item.id }}
            label="Close"
            ariaLabel={`Close the ${CATEGORY_LABEL[item.category].toLowerCase()} care for ${view.name}`}
            title="Close this care item?"
            explain={`The ${CATEGORY_LABEL[item.category].toLowerCase()} care item for ${view.name || "this person"} leaves the care list and moves to Closed care items below. Its journeys end, and their steps still to do are removed. Nothing else is deleted, and its other follow-ups stay as they are.`}
            confirmLabel="Close care item"
          />
          {view.journeyChoices && item.status !== "closed" ? <StartJourney item={item} who={view.name} choices={view.journeyChoices} running={runningKeys(view.journeys ?? [], item.id)} today={view.today} /> : null}
          {canManageMealPages(actor) && item.status !== "closed" ? (
            <Link href={`/meals/new?careItem=${item.id}`} className={btnQuiet}>
              Start a Mitzvah Meals page
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One contact in the history; its author can edit and delete it. */
function ContactRow({ c, actor }: { c: ContactEntry; actor: Actor }) {
  const mine = c.authorUserId === actor.id;
  const outcome = c.outcome ? OUTCOME_LABEL[c.outcome as OutcomeKey] : null;
  return (
    <li className={cardClass} data-testid="contact-entry">
      {c.noteHidden ? (
        <p className="text-base">Contact on {instantDate(c.occurredAt)}</p>
      ) : (
        <p className="text-sm font-medium">
          {outcome ?? KIND[c.kind]} on {instantDate(c.occurredAt)}
        </p>
      )}
      <p className="text-sm text-rubric">
        {mine ? "You" : (c.authorName ?? "A colleague")}
        {c.private && mine ? " · private" : ""}
      </p>
      {c.note ? <p className="mt-2 whitespace-pre-wrap text-base">{c.note}</p> : null}
      {mine ? (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <Sheet label="Edit" ariaLabel={`Edit the contact on ${instantDate(c.occurredAt)}`} title="Edit this contact">
            <ActionForm action={updateContactAction} className="flex flex-col gap-4">
              <input type="hidden" name="entryId" value={c.id} />
              <div>
                <label htmlFor={`ce-outcome-${c.id}`} className={labelClass}>
                  What happened
                </label>
                <select id={`ce-outcome-${c.id}`} name="outcome" className={inputClass} defaultValue={c.outcome ?? ""}>
                  <option value="">{KIND[c.kind]}, no outcome</option>
                  {OUTCOME_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {OUTCOME_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`ce-note-${c.id}`} className={labelClass}>
                  Note
                </label>
                <textarea id={`ce-note-${c.id}`} name="note" rows={6} maxLength={5000} defaultValue={c.note ?? ""} className={`${inputClass} min-h-36 resize-y py-2`} />
              </div>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name="private" defaultChecked={c.private} className={checkBox} />
                Private: only I can read this note
              </label>
              <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                Save
              </button>
            </ActionForm>
          </Sheet>
          <ConfirmAction action={deleteContactAction} fields={{ entryId: c.id }} label="Delete" ariaLabel={`Delete the contact on ${instantDate(c.occurredAt)}`} title="Delete this contact?" explain="The entry and its note are removed for good." confirmLabel="Delete contact" />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Care, other follow-ups, closed items and the contact history of a person: one set of
 * sections for people in Salesforce and for people outside the directory.
 */
export function PersonCare({ view, actor }: { view: CareView; actor: Actor }) {
  const holders = holdersOf(view.team);
  const live = view.careItems.filter((i) => i.status !== "closed");
  const closed = view.careItems.filter((i) => i.status === "closed");
  const openFollowUps = view.followUps.filter((f) => !f.doneAt);
  // A follow-up whose care item is not shown here (not visible to this viewer, or closed) must not vanish.
  const shown = new Set(live.map((i) => i.id));
  const loose = openFollowUps.filter((f) => !f.careItemId || !shown.has(f.careItemId));
  const manage = canManageCareItems(actor);
  return (
    <>
      <Section title="Care" empty="Not on the care list.">
        {live.length > 0 || view.restrictedCare.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-3">
            {live.map((item) => (
              <CareItemCard key={item.id} item={item} view={view} actor={actor} holders={holders} />
            ))}
            {view.restrictedCare.map((s) => (
              <RestrictedStub key={s.id} stub={s} />
            ))}
          </ul>
        ) : undefined}
      </Section>

      {view.miSheberach && view.miSheberach.person.length > 0 ? (
        <Section title="Mi Sheberach">
          <p className="mt-2 text-base" data-testid="person-mi-sheberach">
            {view.miSheberach.person.map((e) => `On the Mi Sheberach list since ${monthDay(e.dateAdded)}${e.kind === "standing" ? ", until further notice" : ""}.`).join(" ")}
          </p>
        </Section>
      ) : null}

      {loose.length > 0 ? (
        <Section title="Other follow-ups">
          <ul className="mt-2 flex flex-col gap-3">
            {loose.map((f) => (
              <FollowUpLine key={f.id} f={f} view={view} actor={actor} holders={holders} boxed />
            ))}
          </ul>
        </Section>
      ) : null}

      {closed.length > 0 ? (
        <details className="mt-4">
          <summary className={`${btnText} cursor-pointer`}>Closed care items ({closed.length})</summary>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-rubric">
            {closed.map((i) => (
              <li key={i.id} className="flex flex-col gap-1 border-t border-rule-soft pt-2 first:border-t-0 first:pt-0" data-testid="closed-item">
                <div className="flex flex-wrap items-center gap-x-3">
                  <span>
                    {CATEGORY_LABEL[i.category]}
                    {i.closedAt ? `, closed ${instantDate(i.closedAt)}` : ""}
                  </span>
                  {manage ? (
                    <ActionButton action={reopenCareItemAction} fields={{ careItemId: i.id }} label="Reopen" className={btnQuiet} showOk={false} ariaLabel={`Reopen the ${CATEGORY_LABEL[i.category].toLowerCase()} care item`} />
                  ) : null}
                </div>
                {manage
                  ? (view.miSheberach?.items ?? [])
                      .filter((e) => e.careItemId === i.id)
                      .map((e) => (
                        <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink" data-testid="closed-mi-prompt">
                          <span>{CLOSED_PROMPT(e.name)}</span>
                          <EndEntry id={e.id} name={e.name} />
                        </div>
                      ))
                  : null}
                <OriginalReports reports={view.originalReports?.[i.id]} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/** The contact history, set apart so the page can place it after its dates and household. */
export function ContactHistory({ view, actor }: { view: CareView; actor: Actor }) {
  return (
    <Section title="Contact history" empty="No contacts logged yet.">
      {view.contacts.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-3">
          {view.contacts.map((c) => (
            <ContactRow key={c.id} c={c} actor={actor} />
          ))}
        </ul>
      ) : undefined}
    </Section>
  );
}
