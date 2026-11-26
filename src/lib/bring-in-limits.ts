/** Limits and labels shared by the browser and the server for "bring in your list". No imports, so a client component can use it. */
export const LIST_MAX = 8000;
export const ENTRIES_MAX = 40;
export const ENTRY_MAX = 1000;
export type SplitHow = "ai" | "blank_lines" | "lines" | "one";
/** left_over: words of the paste that fit no person; continued: the rest of an entry that was too long. */
export type SplitNote = "left_over" | "continued";
export type SplitEntry = { text: string; note?: SplitNote };
