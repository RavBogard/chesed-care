import Link from "next/link";
import { acceptAllPendingAction, acceptMemberAction, addPastHelperAction, dismissJoinAgainAction, makeStopLinkAction, markLeftAction, pauseMemberAction, reactivateMemberAction } from "@/app/roster-actions";
import { ActionForm } from "@/components/action-form";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { MemberForm } from "@/components/roster/member-form";
import { ImportedLines } from "@/components/roster/imported-lines";
import { Section } from "@/components/section";
import { Sheet } from "@/components/sheet";
import { AppShell } from "@/components/shell/app-shell";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass, noticeClass, tagNew, tagQuiet } from "@/components/ui";
import { CopyButton } from "@/components/copy-button";
import { instantDate, shortDate } from "@/lib/format";
import { askedAgainWords, CAN_DO_LABEL, HOW_OFTEN_LABEL, PREFER_CONTACT_LABEL, helpedWords, NOT_ASKED_BACK, PAST_HELPERS_HEADING, PENDING_HEADING, PENDING_NOTE, returnConfirmWords, stoppedSelfWords, STOP_LINK_REPLACES, PAST_HELPERS_NOTE, ROSTER_EMPTY, ROSTER_HINTS, SOURCE_LABEL, STATUS_LABEL, IMPORTED_MARK } from "@/lib/roster-wording";
import { canManageRoster } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { listPastHelperCandidates, listRoster, type MemberView, type PastHelperCandidate } from "@/server/volunteers/roster";
import { CAN_DO } from "@/lib/can-do";
import { MEMBER_STATUSES } from "@/server/volunteers/roster-input";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Roster · CRC Care" };

type Search = { q?: string; can?: string; status?: string };

function Filters({ q, can, status }: { q: string; can: string; status: string }) {
  return (
    <form method="get" className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_10rem_auto] sm:items-end" role="search" aria-label="Search the roster">
      <div>
        <label htmlFor="r-q" className={labelClass}>
          Name or area
        </label>
        <input id="r-q" name="q" defaultValue={q} maxLength={80} className={inputClass} />
      </div>
      <div>
        <label htmlFor="r-can" className={labelClass}>
          Can help with
        </label>
        <select id="r-can" name="can" defaultValue={can} className={inputClass}>
          <option value="">Anything</option>
          {CAN_DO.map((k) => (
            <option key={k} value={k}>
              {CAN_DO_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="r-status" className={labelClass}>
          Status
        </label>
        <select id="r-status" name="status" defaultValue={status} className={inputClass}>
          <option value="">All</option>
          {MEMBER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className={btnQuiet}>
        Search
      </button>
    </form>
  );
}

function MemberRow({ m, today }: { m: MemberView; today: string }) {
  const name = [m.firstName, m.lastName].filter(Boolean).join(" ");
  const contacts = [m.email, m.mobile].filter((c): c is string => c !== null);
  return (
    <li className="px-4 py-3" data-testid="roster-member">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-serif text-[1.0625rem] font-semibold leading-snug">{name}</h3>
        <span className="flex flex-wrap gap-2">
          <span className={m.status === "active" ? tagQuiet : tagNew}>{STATUS_LABEL[m.status]}</span>
          {m.emailsHeld && !m.notVolunteered ? (
            <span className={tagQuiet} data-testid="imported-mark">
              {IMPORTED_MARK}
            </span>
          ) : null}
        </span>
      </div>
      {m.askedToJoinAgainAt ? (
        <p className="mt-1 text-sm font-semibold text-alert" data-testid="asked-again">
          {askedAgainWords(instantDate(m.askedToJoinAgainAt))}
        </p>
      ) : null}
      {m.status === "left" && m.stoppedBy === "self" && m.leftAt ? (
        <p className="mt-1 text-sm text-rubric" data-testid="stopped-self">
          {stoppedSelfWords(instantDate(m.leftAt))}
        </p>
      ) : null}
      {m.status === "paused" && m.pausedUntil ? <p className="text-sm text-rubric">Paused until {shortDate(m.pausedUntil)}</p> : null}
      {m.contactDeleted ? <p className="text-sm text-rubric">Contact details deleted.</p> : null}
      {contacts.length > 0 ? (
        <p className="mt-1 break-words text-base">
          {contacts.map((c) => (
            <span key={c} className="block">
              {c}
            </span>
          ))}
        </p>
      ) : null}
      <p className="mt-1 text-sm text-rubric">{m.canDo.length ? m.canDo.map((k) => CAN_DO_LABEL[k as keyof typeof CAN_DO_LABEL] ?? k).join(", ") : "Has not said what they can do yet"}</p>
      {m.availability ? <p className="text-sm text-rubric">Free: {m.availability}</p> : null}
      {m.howOften || m.preferContact ? <p className="text-sm text-rubric">{[m.howOften ? `Asked: ${HOW_OFTEN_LABEL[m.howOften].toLowerCase()}` : null, m.preferContact ? `Prefers: ${PREFER_CONTACT_LABEL[m.preferContact].toLowerCase()}` : null].filter(Boolean).join(" · ")}</p> : null}
      {m.area ? <p className="text-sm text-rubric">Area: {m.area}</p> : null}
      {m.coordinatorNotes ? <p className="mt-1 text-sm">Note: {m.coordinatorNotes}</p> : null}
      <ImportedLines m={m} />
      <p className="mt-1 text-sm text-rubric" data-testid="roster-helped">
        {m.lastHelpedOn ? `Last helped ${shortDate(m.lastHelpedOn)}. ` : ""}
        {helpedWords(m.lastHelpedOn, m.helpedLast12Months)}. {SOURCE_LABEL[m.source]}.
      </p>
      {m.contactDeleted ? null : (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <Sheet label="Edit" ariaLabel={`Edit ${name}`} title={`Edit ${name}`} triggerClassName={btnQuiet}>
            <MemberForm member={m} idPrefix={`m-${m.id}`} />
          </Sheet>
          {m.status === "pending" ? (
            m.stoppedBy === "self" ? (
              <ConfirmAction action={acceptMemberAction} fields={{ memberId: m.id, confirm: "yes" }} label="Accept" ariaLabel={`Accept ${name}`} title={`Accept ${name}?`} explain={returnConfirmWords(m.askedToJoinAgainAt ? instantDate(m.askedToJoinAgainAt) : null, m.leftAt ? instantDate(m.leftAt) : null)} confirmLabel="Accept" />
            ) : (
              <ActionButton action={acceptMemberAction} fields={{ memberId: m.id }} label="Accept" className={btnPrimary} showOk={false} />
            )
          ) : m.status === "active" ? (
            <Sheet label="Pause" ariaLabel={`Pause ${name}`} title={`Pause ${name}`} triggerClassName={btnQuiet}>
              <ActionForm action={pauseMemberAction} className="flex flex-col gap-4">
                <input type="hidden" name="memberId" value={m.id} />
                <div>
                  <label htmlFor={`pause-${m.id}`} className={labelClass}>
                    Pause until
                  </label>
                  <input id={`pause-${m.id}`} name="until" type="date" required min={addDays(today, 1)} defaultValue={addDays(today, 14)} className={inputClass} />
                </div>
                <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                  Pause
                </button>
              </ActionForm>
            </Sheet>
          ) : m.stoppedBy === "self" ? (
            m.askedToJoinAgainAt ? (
              <ConfirmAction action={reactivateMemberAction} fields={{ memberId: m.id, confirm: "yes" }} label="Bring them back" ariaLabel={`Bring ${name} back`} title={`Bring ${name} back?`} explain={returnConfirmWords(instantDate(m.askedToJoinAgainAt), m.leftAt ? instantDate(m.leftAt) : null)} confirmLabel="Bring them back" />
            ) : (
              <p className="self-center text-sm text-rubric">{NOT_ASKED_BACK}</p>
            )
          ) : (
            <ActionButton action={reactivateMemberAction} fields={{ memberId: m.id }} label="Make active" className={btnQuiet} showOk={false} />
          )}
          {m.askedToJoinAgainAt ? (
            <ActionButton action={dismissJoinAgainAction} fields={{ memberId: m.id }} label="Clear the note" className={btnQuiet} showOk={false} />
          ) : null}
          {m.status !== "left" ? (
            <>
              <ConfirmAction action={markLeftAction} fields={{ memberId: m.id }} label="Mark as left" ariaLabel={`Mark ${name} as left`} title={`Mark ${name} as left?`} explain="They will not be asked again. Their contact details are kept." confirmLabel="Mark as left" />
              <ConfirmAction action={makeStopLinkAction} fields={{ memberId: m.id, replace: "yes" }} label="Copy a stop link" ariaLabel={`Copy a stop link for ${name}`} title="Copy a stop link?" explain={STOP_LINK_REPLACES} confirmLabel="Make a new link" />
            </>
          ) : null}
        </div>
      )}
    </li>
  );
}

function PastHelpers({ helpers }: { helpers: PastHelperCandidate[] }) {
  if (helpers.length === 0) return null;
  return (
    <Section title={PAST_HELPERS_HEADING}>
      <p className="mt-2 text-sm text-rubric">{PAST_HELPERS_NOTE}</p>
      <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="past-helpers">
        {helpers.map((h) => (
          <li key={h.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
            <span className="min-w-0 break-words text-base">
              <span className="font-semibold">{[h.firstName, h.lastName].filter(Boolean).join(" ") || "Name not given"}</span>
              <span className="block text-sm text-rubric">
                {h.email ?? h.mobile} · helped {shortDate(h.lastDate)}
              </span>
            </span>
            <ActionButton action={addPastHelperAction} fields={{ key: h.key }} label="Add to the roster" className={btnQuiet} showOk={false} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The Mitzvah Corps roster: owner, clergy and the lead. Contacts show here and nowhere else (and in "copy contacts" when asking for help). No export. */
export default async function RosterPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canManageRoster(actor)) {
    return (
      <AppShell actor={actor} title="Roster">
        <p className={noticeClass}>You do not have access to the roster.</p>
      </AppShell>
    );
  }
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const can = typeof sp.can === "string" ? sp.can : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const db = getDb();
  const [members, helpers] = await soft<[MemberView[] | null, PastHelperCandidate[]]>("Roster: unavailable", [null, []], () => Promise.all([listRoster(db, actor, { q, can, status }), listPastHelperCandidates(db, actor)]));
  const today = chicagoToday(new Date());
  const filtered = q !== "" || can !== "" || status !== "";
  const pending = (members ?? []).filter((m) => m.status === "pending");
  const rest = (members ?? []).filter((m) => m.status !== "pending");
  // An imported member's email is left out: they are phoned until their email is turned on.
  // Only people who may be asked: not someone from "IL members" who has not volunteered.
  const contacts = rest.filter((m) => m.status === "active" && !m.notVolunteered).flatMap((m) => [m.emailsHeld ? null : m.email, m.mobile]).filter((c): c is string => c !== null);
  return (
    <AppShell actor={actor} title="Roster">
      <p className="mb-5 flex flex-wrap gap-2">
        <Sheet label="Add someone" title="Add someone to the roster" triggerClassName={btnPrimary}>
          <MemberForm idPrefix="new-member" />
        </Sheet>
        <Link href="/volunteers/roster/sign" className={btnQuiet}>
          Print the sign-up page
        </Link>
      </p>
      <p className="mb-5 text-sm text-rubric">{ROSTER_HINTS.noExport}</p>
      {pending.length > 0 ? (
        <Section title={PENDING_HEADING}>
          <p className="mt-2 text-sm text-rubric">{PENDING_NOTE}</p>
          <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="roster-pending">
            {pending.map((m) => (
              <MemberRow key={m.id} m={m} today={today} />
            ))}
          </ul>
          <ActionButton action={acceptAllPendingAction} fields={{}} label="Accept everyone waiting" className={btnQuiet} formClassName="mt-3" showOk={true} />
        </Section>
      ) : null}
      <div className="mt-7" />
      <Filters q={q} can={can} status={status} />
      {members === null ? <LoadNotice what="The roster" /> : null}
      {members && members.length === 0 ? <p className="text-rubric">{filtered ? "Nobody matches that." : ROSTER_EMPTY}</p> : null}
      {members && rest.length > 0 ? (
        <>
          <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-rubric">
            {rest.length === 1 ? "1 person" : `${rest.length} people`}
            {contacts.length > 0 ? <CopyButton text={contacts.join(", ")} label="Copy contacts of the active people shown" /> : null}
          </p>
          <ul className="divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="roster-list">
            {rest.map((m) => (
              <MemberRow key={m.id} m={m} today={today} />
            ))}
          </ul>
        </>
      ) : null}
      <PastHelpers helpers={helpers} />
    </AppShell>
  );
}
