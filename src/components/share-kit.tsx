"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { btnPrimary, btnQuiet } from "@/components/ui";

/**
 * Everything needed to send a link out: copy it, the phone's own share sheet where there is
 * one, a prefilled text (and email, when `emailSubject` is given) from the sender's own phone or
 * mail app, and a printable flyer. Nothing is sent from here. `text` goes to the share sheet
 * beside the link; `message` is the whole text or email body, link included.
 */
export function ShareKit({
  url,
  shareTitle,
  text,
  message,
  shareLabel,
  emailSubject,
  flyerHref,
  className = "flex flex-col gap-2",
  children,
}: {
  url: string;
  shareTitle: string;
  text: string;
  message: string;
  shareLabel?: string;
  emailSubject?: string;
  flyerHref?: string;
  className?: string;
  children?: ReactNode;
}) {
  // The phone's share sheet exists only in the browser: false on the server and while hydrating.
  const canShare = useSyncExternalStore(
    () => () => {},
    () => typeof navigator.share === "function",
    () => false,
  );
  const [note, setNote] = useState("");
  return (
    <div className={className}>
      <div className="flex flex-wrap items-start gap-2">
        {canShare ? (
          <button
            type="button"
            className={btnPrimary}
            aria-label={shareLabel}
            onClick={async () => {
              try {
                await navigator.share({ title: shareTitle, text, url });
              } catch (error) {
                // Closing the share sheet is not a failure.
                if (!(error instanceof DOMException && error.name === "AbortError")) setNote("Sharing did not work. Copy the link instead.");
              }
            }}
          >
            Share
          </button>
        ) : null}
        <CopyButton text={url} label="Copy the link" />
        <a href={`sms:?&body=${encodeURIComponent(message)}`} className={btnQuiet}>
          Text it
        </a>
        {emailSubject ? (
          <a href={`mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(message)}`} className={btnQuiet}>
            Email it
          </a>
        ) : null}
        {flyerHref ? (
          <Link href={flyerHref} className={btnQuiet}>
            Print a flyer
          </Link>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-sm text-alert empty:hidden">
        {note}
      </p>
      {children}
    </div>
  );
}
