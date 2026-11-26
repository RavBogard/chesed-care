"use client";

import { createContext, useContext, useEffect, useId, useRef } from "react";
import { btnQuiet } from "./ui";

const SheetContext = createContext<{ close: () => void } | null>(null);

/** Close the surrounding sheet (used by forms when they succeed). */
export function useSheet() {
  return useContext(SheetContext);
}

/** The control that should have focus when a sheet opens: the one marked data-autofocus, else the first field. */
const FIRST = "[data-autofocus], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])";

/** Anything typed in a sheet that closing would hide (the note of a contact). */
function hasTypedText(el: HTMLElement): boolean {
  return Array.from(el.querySelectorAll("textarea")).some((t) => t.value.trim() !== "");
}

/** A page that opened a sheet through ?action= must not reopen it on refresh once it is closed. */
function dropActionParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("action")) return;
    url.searchParams.delete("action");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A URL that cannot be rewritten is left alone.
  }
}

/** A sheet opened from the URL has no earlier focus to return to, so focus would fall to the page body: send it to the opening button, else the page heading. */
function restoreFocus(trigger: HTMLElement | null) {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  if (trigger?.isConnected) {
    trigger.focus();
    return;
  }
  const h1 = document.querySelector<HTMLElement>("h1");
  h1?.setAttribute("tabindex", "-1");
  h1?.focus();
}

/** The same form set on the page itself, when the screen is laptop-wide (Tailwind's lg) and it is there. */
function formOnPage(id: string | undefined): HTMLElement | null {
  if (!id || typeof window.matchMedia !== "function" || !window.matchMedia("(min-width: 64rem)").matches) return null;
  return document.getElementById(id);
}

/**
 * A button that opens a bottom sheet (a native modal dialog: focus is trapped, Esc closes).
 * Focus starts on the first field, not on Close. A click on the backdrop closes the sheet
 * unless a note has been typed in it. `title` is the sheet's accessible name.
 * `inlineId` names an element that holds the same form on the page itself on a laptop: there
 * the button is hidden, and an arrival that would open the sheet goes to that form instead.
 */
export function Sheet({ label, title, children, defaultOpen = false, triggerClassName = btnQuiet, inlineId, onClosed, ariaLabel }: { label: string; title: string; children: React.ReactNode; defaultOpen?: boolean; triggerClassName?: string; inlineId?: string; onClosed?: () => void; ariaLabel?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const open = () => {
    const el = ref.current;
    if (!el || el.open) return;
    el.showModal();
    el.querySelector<HTMLElement>(FIRST)?.focus();
  };
  useEffect(() => {
    if (!defaultOpen) return;
    const onPage = formOnPage(inlineId);
    if (onPage) {
      // A laptop: the form is already on the page. Go to it, and do not cover the history with a dialog.
      onPage.querySelector<HTMLElement>(FIRST)?.focus();
      dropActionParam();
    } else open();
  }, [defaultOpen, inlineId]);
  const close = () => ref.current?.close();
  return (
    <SheetContext.Provider value={{ close }}>
      <button ref={trigger} type="button" aria-label={ariaLabel} className={inlineId ? `${triggerClassName} lg:hidden` : triggerClassName} onClick={open}>
        {label}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        className="fixed inset-x-0 bottom-0 top-auto m-0 mx-auto max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-md border-t border-control bg-ground p-5 pb-8 text-ink sm:bottom-auto sm:top-16 sm:rounded-md sm:border lg:max-w-2xl"
        onClose={() => {
          dropActionParam();
          restoreFocus(trigger.current);
          onClosed?.();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !hasTypedText(e.currentTarget)) close();
        }}
      >
        <div className="mb-4 flex items-start justify-between gap-3 border-b border-rule pb-3">
          <h2 id={titleId} className="min-w-0 break-words font-serif text-xl font-bold leading-snug">
            {title}
          </h2>
          <button type="button" className={btnQuiet} onClick={close}>
            Close
          </button>
        </div>
        {children}
      </dialog>
    </SheetContext.Provider>
  );
}
