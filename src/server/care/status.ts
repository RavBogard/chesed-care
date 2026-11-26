/**
 * Care item status. PURE (no database): shared by the server functions and the screens.
 *
 * new: just created, no contact yet. open: in active care. paused: set aside until
 * paused_until. closed: no longer in active care.
 *
 * "Active" is new or open, or paused with paused_until on or before today (Chicago).
 * A paused item comes back by this comparison when it is read; no job wakes it.
 */
export type CareStatus = "new" | "open" | "paused" | "closed";

export function isActiveCareItem(item: { status: CareStatus; pausedUntil: string | null }, today: string): boolean {
  if (item.status === "new" || item.status === "open") return true;
  return item.status === "paused" && item.pausedUntil !== null && item.pausedUntil <= today;
}

/** Paused and not yet due back. */
export function isPausedCareItem(item: { status: CareStatus; pausedUntil: string | null }, today: string): boolean {
  return item.status === "paused" && !isActiveCareItem(item, today);
}
