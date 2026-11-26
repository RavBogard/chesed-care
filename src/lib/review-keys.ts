/** How long after an entry appears its keys are ignored, so a key still held from the last one cannot act on the next. */
export const KEY_SETTLE_MS = 700;

/** What a key press does on the list review: pure, so the guards can be tested without a browser. */
export function reviewKeyAction(k: { key: string; repeat: boolean; msSinceMount: number; modifier: boolean; inControl: boolean; dialogOpen: boolean }): "accept" | "skip" | null {
  if (k.repeat || k.modifier || k.inControl || k.dialogOpen || k.msSinceMount < KEY_SETTLE_MS) return null;
  if (k.key === "Enter") return "accept";
  if (k.key === "s" || k.key === "S") return "skip";
  return null;
}
