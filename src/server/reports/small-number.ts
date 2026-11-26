/**
 * The small-number rule for the no-names reports. Nothing under SMALL_NUMBER is shown (the
 * screen says "fewer than 5"), everything shown is rounded to the nearest 5, and a total beside
 * hidden cells is hidden or a second cell is hidden, so a hidden count cannot be subtracted back
 * out of what is shown. Pure; the policy decides who gets it (policy.ts reportsAreNameless).
 */
import { SMALL_NUMBER } from "@/server/access/policy";

/** A count, or null for "fewer than 5". */
export type Cell = number | null;

const round5 = (n: number) => Math.round(n / 5) * 5;

/** One count: hidden under 5, otherwise to the nearest 5. */
export function hideSmall(n: number): Cell {
  return n < SMALL_NUMBER ? null : round5(n);
}

/**
 * A row of cells and its total. An exact zero is a shown value, not a hidden cell: it gives
 * nothing away, so a row like 0, 0, 12 keeps its total. Only a count of 1 to 4 is hidden.
 * Exactly one such cell: the smallest other non-zero cell is hidden too, so the total cannot
 * give it back (zeros do not help: they are known). Two or more: the total is hidden.
 */
export function hideSmallInGroup(values: number[]): { cells: Cell[]; total: Cell } {
  const hide = values.map((v) => v > 0 && v < SMALL_NUMBER);
  const hidden = hide.filter(Boolean).length;
  const sum = values.reduce((a, b) => a + b, 0);
  let totalShown = sum >= SMALL_NUMBER;
  if (hidden === 1) {
    let at = -1;
    values.forEach((v, i) => {
      if (!hide[i] && v > 0 && (at === -1 || v < values[at])) at = i;
    });
    if (at >= 0) hide[at] = true;
  } else if (hidden >= 2) {
    totalShown = false;
  }
  return { cells: values.map((v, i) => (hide[i] ? null : round5(v))), total: totalShown ? round5(sum) : null };
}

/**
 * Row totals and a grand total over them: a hidden row total hides the grand total, because the
 * grand total minus the shown rows would give the hidden row back.
 */
export function grandTotal(rowTotals: Cell[], raw: number): Cell {
  if (rowTotals.some((t) => t === null)) return null;
  return hideSmall(raw);
}
