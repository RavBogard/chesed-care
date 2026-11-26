"use client";

import { useEffect, useRef, useState } from "react";
import { btnQuiet } from "./ui";

/** A short message that clears itself after four seconds: what a copy button says out loud. */
export function useBriefMessage(): [string, (m: string) => void] {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = (m: string) => {
    setMessage(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), 4000);
  };
  return [message, say];
}

/**
 * Copies `text` to the clipboard and says so out loud ("Copied") for a few seconds. With `link`,
 * `text` may be a path: it is made whole from the address the page was opened at.
 */
export function CopyButton({
  text,
  label,
  link = false,
  className = btnQuiet,
  failed = "Could not copy. Select the address and copy it by hand.",
}: {
  text: string;
  label: string;
  link?: boolean;
  className?: string;
  failed?: string;
}) {
  const [message, say] = useBriefMessage();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={className}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link ? new URL(text, window.location.origin).toString() : text);
            say("Copied");
          } catch {
            say(failed);
          }
        }}
      >
        {label}
      </button>
      <span role="status" aria-live="polite" className="text-sm font-medium text-done empty:hidden">
        {message}
      </span>
    </span>
  );
}
