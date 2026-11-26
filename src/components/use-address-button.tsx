"use client";

import { useState } from "react";
import { btnQuiet } from "./ui";

/** Fills a text field with a person's address when pressed, never before. The organiser reads and can edit it. */
export function UseAddressButton({ targetId, address }: { targetId: string; address: string | null }) {
  const [done, setDone] = useState(false);
  if (!address) return null;
  return (
    <span className="mb-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={btnQuiet}
        data-testid="use-address"
        onClick={() => {
          const field = document.getElementById(targetId);
          if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return;
          field.value = address;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.focus();
          setDone(true);
        }}
      >
        Use their address
      </button>
      <span role="status" aria-live="polite" className="text-sm font-medium text-done empty:hidden">
        {done ? "Address filled in. You can change it." : ""}
      </span>
    </span>
  );
}
