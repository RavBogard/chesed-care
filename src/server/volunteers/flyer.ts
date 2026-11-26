import type { SheetView, TaskView } from "./organiser";

/**
 * The link a flyer may carry. Same rule as the public page: a link is shown only while
 * the task or sheet is open and its date has not gone by; otherwise the flyer has
 * nothing to print.
 */
export function taskFlyerUrl(task: Pick<TaskView, "status" | "past" | "publicToken">, origin: string): string | null {
  return origin && task.publicToken && task.status === "open" && !task.past ? `${origin}/v/${task.publicToken}` : null;
}

export function sheetFlyerUrl(sheet: Pick<SheetView, "cancelled" | "publicToken"> & { evenings: Pick<TaskView, "status" | "past">[] }, origin: string): string | null {
  const anyOpen = sheet.evenings.some((e) => e.status === "open" && !e.past);
  return origin && sheet.publicToken && !sheet.cancelled && anyOpen ? `${origin}/v/s/${sheet.publicToken}` : null;
}

export const boardFlyerUrl = (board: { token: string } | null, origin: string): string | null => (origin && board ? `${origin}/v/b/${board.token}` : null);
