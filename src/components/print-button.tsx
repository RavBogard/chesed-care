"use client";

import { btnPrimary } from "@/components/ui";

/** Opens the browser's print dialog. With `hideOnPaper` the button itself is left off the printed page. */
export function PrintButton({ hideOnPaper = false }: { hideOnPaper?: boolean }) {
  return (
    <button type="button" className={hideOnPaper ? `${btnPrimary} print:hidden` : btnPrimary} onClick={() => window.print()}>
      Print
    </button>
  );
}
