"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { createBatchAction, splitListAction } from "@/app/bring-in-actions";
import { ENTRIES_MAX, ENTRY_MAX, LIST_MAX, type SplitEntry, type SplitHow } from "@/lib/bring-in-limits";
import { btnLaptopNatural, btnPrimary, btnQuiet, btnText, cardClass, inputClass, labelClass, noticeClass, tagNew } from "./ui";

type Entry = SplitEntry & { id: number };

const EXAMPLE = "Ruth Cohen, 84, broke her hip, home from rehab, daughter Dana calls on Sundays.\nThe Levine family: Sam is in chemo, Joan is exhausted, two teenagers at home.";

const HOW_NOTE: Record<SplitHow, string> = {
  ai: "The app’s AI read your list once, only to cut it into people. It did not sort or judge anything. Check each piece.",
  blank_lines: "Cut at the blank lines you left. Check each piece.",
  lines: "Cut at each line break. Check each piece.",
  one: "This looks like one long paragraph, so it is one entry. If it holds several people, go back and put each on its own line.",
};

/**
 * Paste or dictate the whole caseload, check how it was cut into people, then add them to
 * the Inbox. The pasted text lives only in this page's memory until the clergy member presses
 * the button: nothing is stored before that, and only the confirmed pieces are ever saved.
 */
export function BringInForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [how, setHow] = useState<SplitHow>("lines");
  const [more, setMore] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const next = useRef(0);
  const boxes = useRef(new Map<number, HTMLTextAreaElement>());
  const make = (e: SplitEntry): Entry => ({ ...e, id: next.current++ });

  const split = () => {
    if (!text.trim() || pending) return;
    setError("");
    startTransition(async () => {
      const r = await splitListAction(text);
      if (r.status === "error") return setError(r.message);
      setEntries(r.data.entries.map(make));
      setHow(r.data.how);
      setMore(r.data.more);
      setDiscarded(r.data.discarded);
    });
  };

  const edit = (id: number, t: string) => setEntries((es) => es?.map((e) => (e.id === id ? { ...e, text: t } : e)) ?? null);
  const remove = (id: number) => setEntries((es) => es?.filter((e) => e.id !== id) ?? null);
  const join = (i: number) =>
    setEntries((es) => {
      if (!es || i < 1) return es;
      const merged = { ...es[i - 1], text: `${es[i - 1].text.trim()} ${es[i].text.trim()}`.slice(0, ENTRY_MAX) };
      return [...es.slice(0, i - 1), merged, ...es.slice(i + 1)];
    });
  const cut = (i: number) =>
    setEntries((es) => {
      const e = es?.[i];
      const at = e ? boxes.current.get(e.id)?.selectionStart : undefined;
      if (!es || !e || at === undefined || at <= 0 || at >= e.text.length) return es;
      const a = e.text.slice(0, at).trim();
      const b = e.text.slice(at).trim();
      if (!a || !b || es.length >= ENTRIES_MAX) return es;
      return [...es.slice(0, i), { ...e, text: a }, make({ text: b }), ...es.slice(i + 1)];
    });

  const kept = (entries ?? []).map((e) => e.text.trim()).filter(Boolean);
  const save = () => {
    if (kept.length === 0 || pending) return;
    setError("");
    startTransition(async () => {
      const r = await createBatchAction(kept);
      if (r.status === "error") return setError(r.message);
      router.push("/inbox/bring-in/review");
    });
  };

  if (entries === null) {
    return (
      // Never a native submit: a GET would put the pasted names in the address bar. The text is only sent by the handler
      // below (compare action-form.tsx), and the textarea has no name for a browser to send.
      <form method="post" onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-3">
        <label htmlFor="bring-in-text" className={labelClass}>
          Paste or dictate everyone you are caring for right now. One person or family per line is easiest, but any notes will do.
        </label>
        <textarea
          id="bring-in-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          maxLength={LIST_MAX}
          required
          placeholder={EXAMPLE}
          autoComplete="off"
          spellCheck
          className={`${inputClass} min-h-72 py-3 leading-relaxed`}
          aria-describedby="bring-in-count bring-in-status"
        />
        <p id="bring-in-count" className="text-sm text-rubric tabular-nums">
          {text.length.toLocaleString("en-US")} of {LIST_MAX.toLocaleString("en-US")} characters. On a phone, the microphone on your keyboard works here. Nothing is saved until you check the list and confirm.
        </p>
        <p id="bring-in-status" role="status" aria-live="polite" className="text-sm font-medium text-alert empty:hidden">
          {error}
        </p>
        <div>
          <button type="button" onClick={split} aria-disabled={pending} className={`${btnPrimary} w-full ${btnLaptopNatural}`}>
            {pending ? "Reading your list…" : "Continue"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="bring-in-check">
      <div>
        <h2 className="font-serif text-lg font-bold leading-snug">{kept.length === 1 ? "1 entry" : `${kept.length} entries`}</h2>
        <p className="mt-1 text-sm text-rubric">{HOW_NOTE[how]}</p>
        {discarded ? <p className={`${noticeClass} mt-2`}>The AI&rsquo;s way of cutting your list did not fit your text well, so it was cut at your line breaks instead. Check each piece.</p> : null}
        {entries.some((e) => e.note === "left_over") ? (
          <p className={`${noticeClass} mt-2`} data-testid="bring-in-left-over-notice">
            Some of what you pasted did not fit a person. Please look at the entries marked &ldquo;left over&rdquo;.
          </p>
        ) : null}
        {more ? <p className={`${noticeClass} mt-2`}>Only the first {ENTRIES_MAX} are shown. Bring in the rest in a second list afterwards.</p> : null}
      </div>
      <ol className="flex flex-col gap-3" aria-label="Entries">
        {entries.map((e, i) => (
          <li key={e.id} className={cardClass} data-testid="bring-in-entry">
            <label htmlFor={`entry-${e.id}`} className="mb-1 block text-sm font-semibold text-rubric">
              {i + 1} of {entries.length}
              {e.note === "left_over" ? (
                <span className={`${tagNew} ml-2 align-middle`} data-testid="bring-in-left-over">
                  Left over
                </span>
              ) : null}
              {e.note === "continued" ? (
                <span className="ml-2 font-normal" data-testid="bring-in-continued">
                  Continued from the entry above
                </span>
              ) : null}
            </label>
            <textarea
              id={`entry-${e.id}`}
              ref={(el) => {
                if (el) boxes.current.set(e.id, el);
                else boxes.current.delete(e.id);
              }}
              value={e.text}
              onChange={(ev) => edit(e.id, ev.target.value)}
              maxLength={ENTRY_MAX}
              rows={3}
              className={`${inputClass} py-2`}
            />
            <div className="mt-1 flex flex-wrap gap-x-4">
              {i > 0 ? (
                <button type="button" className={btnText} onClick={() => join(i)}>
                  Join with the one above
                </button>
              ) : null}
              <button type="button" className={btnText} onClick={() => cut(i)}>
                Split at the cursor
              </button>
              <button type="button" className={btnText} onClick={() => remove(e.id)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ol>
      <p role="status" aria-live="polite" className="text-sm font-medium text-alert empty:hidden">
        {error}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${btnPrimary} ${btnLaptopNatural}`} aria-disabled={pending || kept.length === 0} onClick={save}>
          {pending ? "Adding…" : "Add these to my Inbox"}
        </button>
        <button type="button" className={btnQuiet} onClick={() => setEntries(null)}>
          Back to my text
        </button>
      </div>
    </div>
  );
}
