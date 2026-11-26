"use client";

import { useEffect, useRef } from "react";

/**
 * "n of m done" for today's dates. When a row is marked done the count closes with one short
 * emphasis: the app's single authored motion. It never plays on arrival or on an undo, and
 * not at all for someone who has asked for reduced motion.
 */
export function DoneCount({ finished, total }: { finished: number; total: number }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const before = useRef(finished);
  useEffect(() => {
    const rose = finished > before.current;
    before.current = finished;
    const el = ref.current;
    if (!rose || !el || typeof el.animate !== "function") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [
        { transform: "translateY(0.2em) scale(1.12)", opacity: 0.4 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 280, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }, [finished]);
  return (
    <p ref={ref} className="origin-right text-sm font-medium text-rubric tabular-nums" data-testid="today-progress">
      {total === 1 ? "1 date today" : `${total} dates today`}, {finished} done
    </p>
  );
}
