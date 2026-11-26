"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { reviewKeyAction } from "@/lib/review-keys";

/**
 * Keyboard for the list review: Enter presses the primary button, S skips. Only while nothing that takes
 * typing (or its own Enter) has focus, never while a dialog is open, never for a held key, and not in the
 * moments after an entry appears. This component is keyed by the entry, so each entry starts its own clock;
 * and focus moves to the entry's heading, never to the Accept button, so a stray Enter cannot accept the next one.
 */
export function ReviewKeys({ skipHref }: { skipHref: string }) {
  const router = useRouter();
  useEffect(() => {
    const mounted = Date.now();
    document.querySelector<HTMLElement>("[data-review-heading]")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      const action = reviewKeyAction({
        key: e.key,
        repeat: e.repeat,
        msSinceMount: Date.now() - mounted,
        modifier: e.metaKey || e.ctrlKey || e.altKey,
        inControl: !!el?.closest("input, textarea, select, button, a, summary, [contenteditable='true']"),
        dialogOpen: !!document.querySelector("dialog[open], [role='dialog']"),
      });
      if (action === "accept") {
        const primary = document.querySelector<HTMLElement>("[data-review-primary], [data-review-primary-wrap] button");
        if (primary) {
          e.preventDefault();
          primary.click();
        }
      } else if (action === "skip") {
        e.preventDefault();
        router.push(skipHref);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router, skipHref]);
  return null;
}
