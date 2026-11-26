"use client";

import { useEffect } from "react";

/** Opens and scrolls to the day a #day-… link points at, on load and when the hash changes. Renders nothing. */
export function DayAnchorOpener() {
  useEffect(() => {
    const go = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id.startsWith("day-")) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ block: "start" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
  return null;
}
