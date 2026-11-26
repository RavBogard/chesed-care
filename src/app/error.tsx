"use client";

import { useEffect } from "react";
import { PlainPage } from "@/components/plain-page";
import { btnPrimary } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Page error", error.name, error.digest ?? "");
  }, [error]);
  return (
    <PlainPage title="That did not load">
      <p className="text-ink">Something went wrong on our side. Your notes are safe. Please try again.</p>
      <button type="button" onClick={reset} className={btnPrimary}>
        Try again
      </button>
    </PlainPage>
  );
}
