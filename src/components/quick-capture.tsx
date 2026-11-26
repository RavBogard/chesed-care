"use client";

import { startTransition, useActionState, useState } from "react";
import { captureAction, dismissProposalAction, releaseProposalAction, type Captured } from "@/app/inbox-actions";
import { ActionForm } from "./action-form";
import type { TeamChoice } from "./care-fields";
import { DecisionForm } from "./decision-form";
import type { JourneyOption } from "./journey-picker";
import { Sheet } from "./sheet";
import { btnPrimary, btnQuiet, btnText, inputClass, labelClass } from "./ui";

const IDLE: Captured = { status: "idle" };

/** Discard asks once, in place: a second tap discards the words for good. */
function Discard({ proposalId, onDone }: { proposalId: string; onDone: () => void }) {
  const [sure, setSure] = useState(false);
  if (!sure) {
    return (
      <button type="button" className={btnText} onClick={() => setSure(true)}>
        Discard
      </button>
    );
  }
  return (
    <ActionForm action={dismissProposalAction} showOk={false} onOk={onDone} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="proposalId" value={proposalId} />
      <span className="text-sm">Discard these words for good?</span>
      <button type="submit" className={btnQuiet}>
        Yes, discard
      </button>
      <button type="button" data-autofocus className={btnQuiet} onClick={() => setSure(false)}>
        Keep
      </button>
    </ActionForm>
  );
}

/**
 * Quick capture, at the top of Today for clergy: one box, "Who needs care? Type or dictate a
 * sentence." Sending it saves the words as the writer's own note (nothing reaches the care
 * list yet) and opens the decision sheet at once with the words shown above the fields.
 * Closing the sheet unfinished leaves the note waiting in the writer's Inbox.
 */
export function QuickCapture({ today, actorId, holders, journeyChoices = [] }: { today: string; actorId: string; holders: TeamChoice[]; journeyChoices?: JourneyOption[] }) {
  const [state, dispatch, pending] = useActionState(captureAction, IDLE);
  // The note being finished is the latest saved one, until it is saved, discarded or sent on.
  const [finishedId, setFinishedId] = useState<string | null>(null);
  const open = state.status === "ok" && state.data.id !== finishedId ? state.data : null;
  const finished = () => setFinishedId(state.status === "ok" ? state.data.id : null);
  return (
    <section aria-label="Quick capture" className="mb-8">
      <form
        key={state.status === "ok" ? state.data.id : "writing"}
        action={dispatch}
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const data = new FormData(e.currentTarget);
          if (!String(data.get("words") ?? "").trim()) return;
          startTransition(() => dispatch(data));
        }}
      >
        <label htmlFor="capture-words" className={labelClass}>
          Who needs care? Type or dictate a sentence.
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <textarea id="capture-words" name="words" rows={2} maxLength={5000} required className={`${inputClass} py-2`} aria-describedby="capture-status" />
          <button type="submit" aria-disabled={pending} className={`${btnPrimary} sm:min-w-32`}>
            {pending ? "Saving…" : "Continue"}
          </button>
        </div>
        <p id="capture-status" role="status" aria-live="polite" className="mt-2 text-sm font-medium text-alert empty:hidden">
          {state.status === "error" ? state.message : ""}
        </p>
      </form>
      {open ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Sheet key={open.id} label="Finish this note" title="Who needs care?" defaultOpen triggerClassName={btnQuiet}>
            <DecisionForm
              proposalId={open.id}
              words={open.words}
              today={today}
              actorId={actorId}
              holders={holders}
              journeyChoices={journeyChoices}
              initial={{ person: null }}
              onOk={finished}
              footer={
                <>
                  <ActionForm action={releaseProposalAction} showOk={false} onOk={finished}>
                    <input type="hidden" name="proposalId" value={open.id} />
                    <button type="submit" className={btnQuiet}>
                      Send to the Inbox for someone else
                    </button>
                  </ActionForm>
                  <Discard proposalId={open.id} onDone={finished} />
                </>
              }
            />
          </Sheet>
          <p className="text-sm text-rubric">Not finished? It waits in your Inbox.</p>
        </div>
      ) : null}
    </section>
  );
}
