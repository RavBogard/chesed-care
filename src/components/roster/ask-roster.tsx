"use client";

import { useState, useTransition } from "react";
import { askRosterAction, emailRosterAction } from "@/app/roster-actions";
import { CopyButton } from "@/components/copy-button";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, noticeClass } from "@/components/ui";
import { ASK_EMAIL_BUTTON, ASK_EMAIL_OFF, ASK_EMAIL_TOO_MANY, ASK_EMPTY, ASK_INTRO, ASK_RECORDED, ASK_SUBMIT, ASKED_RECENTLY, askEmailResult, askedWords, helpedWords, prefersWords } from "@/lib/roster-wording";
import type { AskPrepared } from "@/server/volunteers/roster";

export type AskRow = { id: string; name: string; hasEmail: boolean; hasMobile: boolean; lastAsked: string | null; lastHelped: string | null; helpedLast12Months: number; preferContact: "email" | "text" | "call" | null; askedRecently: boolean };

/**
 * "Ask the roster", open on a task or sheet: tick members (least recently asked first), then get what you need to ask
 * them from your own mail app or phone. The list shows names only; their contacts arrive only in answer to the tap,
 * and the tap records that they were asked. "Send from CRC Care" emails each ticked member who has an address, one by one.
 */
export function AskRoster({ target, rows }: { target: { taskId: string } | { groupId: string }; rows: AskRow[] }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AskPrepared | null>(null);
  const [sentNote, setSentNote] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  if (rows.length === 0) return <p className="text-base text-rubric">{ASK_EMPTY}</p>;
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="flex flex-col gap-4" data-testid="ask-roster">
      <p className="text-sm text-rubric">{ASK_INTRO}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          start(async () => {
            const out = await askRosterAction({ ...target, memberIds: [...picked] });
            if (out.status === "error") setError(out.message);
            else setResult(out.data);
          });
        }}
      >
        <fieldset disabled={pending} className="contents">
          <legend className="sr-only">People to ask</legend>
          <ul className="divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface">
            {rows.map((r) => (
              <li key={r.id} className="px-3">
                <label className={`${checkRow} py-2`}>
                  <input type="checkbox" className={checkBox} checked={picked.has(r.id)} onChange={() => toggle(r.id)} data-testid="ask-member" />
                  <span className="min-w-0">
                    <span className="font-semibold">{r.name}</span>
                    <span className="block text-sm text-rubric">
                      {askedWords(r.lastAsked)} · {helpedWords(r.lastHelped, r.helpedLast12Months)}
                      {r.hasEmail || r.hasMobile ? "" : " · no contact"}
                      {r.preferContact ? ` · ${prefersWords(r.preferContact)}` : ""}
                    </span>
                    {r.askedRecently ? (
                      <span className="block text-sm font-medium text-rubric" data-testid="asked-recently">
                        {ASKED_RECENTLY}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <button type="submit" disabled={pending || picked.size === 0} className={`${btnPrimary} ${btnLaptopNatural}`}>
          {pending ? "Working" : picked.size > 0 ? `${ASK_SUBMIT} (${picked.size})` : ASK_SUBMIT}
        </button>
        <button
          type="button"
          disabled={pending || picked.size === 0}
          className={`${btnQuiet} ${btnLaptopNatural}`}
          data-testid="ask-send-email"
          onClick={() => {
            setError("");
            setSentNote("");
            if (picked.size > 60) {
              setError(ASK_EMAIL_TOO_MANY);
              return;
            }
            start(async () => {
              const out = await emailRosterAction({ ...target, memberIds: [...picked] });
              if (out.status === "error") setError(out.message);
              else setSentNote(out.data.configured ? askEmailResult(out.data.sent, out.data.noEmail, out.data.notSent) : ASK_EMAIL_OFF);
            });
          }}
        >
          {ASK_EMAIL_BUTTON}
        </button>
      </form>
      {sentNote ? (
        <p role="status" className={noticeClass} data-testid="ask-email-result">
          {sentNote}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={noticeClass}>
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="flex flex-col gap-3 rounded-md border border-rule bg-tint p-3" role="status" data-testid="ask-result">
          <p className="text-base font-semibold">
            {ASK_RECORDED} ({result.count})
          </p>
          <div className="flex flex-wrap items-start gap-2">
            {result.emails.length > 0 ? <CopyButton text={result.emails.join(", ")} label="Copy emails" /> : null}
            {result.mobiles.length > 0 ? <CopyButton text={result.mobiles.join(", ")} label="Copy mobile numbers" /> : null}
            {result.mailto.map((href, i) => (
              <a key={href} href={href} className={btnQuiet}>
                {result.mailto.length > 1 ? `Open in my mail app (${i + 1} of ${result.mailto.length})` : "Open in my mail app"}
              </a>
            ))}
            <CopyButton text={result.body} label="Copy the message" />
          </div>
          {result.texts.length > 0 ? (
            <ul className="flex flex-col gap-1" data-testid="ask-texts">
              {result.texts.map((t) => (
                <li key={t.href}>
                  <a href={t.href} className="inline-flex min-h-11 items-center text-base font-medium text-action underline underline-offset-4">
                    Text {t.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
