/** Shared class strings so every control is at least 44px tall and looks the same. */
const base = "inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-center text-sm font-semibold transition-colors disabled:opacity-60";
export const btnPrimary = `${base} bg-action text-on-action hover:bg-action-strong`;
/** The primary button of an occasion, in the fill of its kind. Everything that is not an occasion uses btnPrimary. */
export const btnKind = {
  yahrzeit: `${base} bg-yahrzeit text-on-action hover:bg-yahrzeit-strong`,
  shloshim: `${base} bg-shloshim text-on-action hover:bg-shloshim-strong`,
  birthday: `${base} bg-birthday text-on-action hover:bg-birthday-strong`,
  anniversary: `${base} bg-anniversary text-on-action hover:bg-anniversary-strong`,
} as const;
/** A kind as a solid fill: its tag. */
export const kindFill = {
  yahrzeit: "bg-yahrzeit text-on-action",
  shloshim: "bg-shloshim text-on-action",
  birthday: "bg-birthday text-on-action",
  anniversary: "bg-anniversary text-on-action",
} as const;
/** A kind as a band: the head of its card. Text on a band is ink or the kind's own fill, never rubric. */
export const kindBand = {
  yahrzeit: "bg-yahrzeit-band",
  shloshim: "bg-shloshim-band",
  birthday: "bg-birthday-band",
  anniversary: "bg-anniversary-band",
} as const;
/** A kind as a text colour: its Hebrew, and the heading over its group. */
export const kindText = {
  yahrzeit: "text-yahrzeit",
  shloshim: "text-shloshim",
  birthday: "text-birthday",
  anniversary: "text-anniversary",
} as const;
export const btnQuiet = `${base} border border-control bg-surface text-ink hover:bg-tint`;
/** A quiet button on the shell (the menu's Close). */
export const btnOnShell = `${base} border border-on-shell-muted text-on-shell hover:bg-shell-raised`;
/** A chosen filter: not the solid fill (that means "primary action"), but a heavier outline on a tint, plus a check mark added where it is used. */
export const btnSelected = `${base} border-2 border-action bg-selected text-action`;
/** On a laptop a full-width button takes the width of its words, with a floor, and no longer spans the column. Add to a button that is full-width on a phone. */
export const btnLaptopNatural = "lg:w-auto lg:min-w-44 lg:flex-none lg:self-start";
export const btnText ="inline-flex min-h-11 items-center text-sm font-medium text-action underline underline-offset-4 hover:text-action-strong";
export const inputClass = "min-h-11 w-full rounded-md border border-control bg-surface px-3 text-base text-ink placeholder:text-rubric";
export const labelClass = "mb-1 block text-sm font-semibold text-ink";
export const cardClass = "rounded-md border border-rule bg-surface p-4";
/** The small heading over a group. */
export const rubric = "text-xs font-bold uppercase tracking-[0.09em] text-rubric";
export const noticeClass = "rounded-md bg-alert-band p-3 text-sm text-alert";
/** The title of a card or a day. */
export const titleClass = "font-serif text-lg font-bold leading-snug";
/** A person's name inside a card or a list. */
export const nameClass = "font-serif text-[1.0625rem] font-semibold leading-snug";
/** A name that is also a link, with a full-height target. */
export const nameLink = "inline-flex min-h-11 items-center break-words underline decoration-control underline-offset-4 hover:decoration-action";
/** The facing line: English at the left, Hebrew at the right of the same line; the Hebrew drops beneath when there is no room. */
export const facingLine = "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5";

/** A small solid tag in capitals (set in CSS, so the word is read and copied as written): New, Restricted, Not in Salesforce. */
const tag = "inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-sans text-xs leading-5 font-bold tracking-[0.06em] [overflow-wrap:anywhere] uppercase";
export const tagNew = `${tag} bg-alert-band text-alert`;
export const tagQuiet = `${tag} bg-tint text-ink`;
export const tagRestricted = `${tag} bg-shell text-on-shell`;
/** A group of fields inside a form. */
export const fieldsetClass = "rounded-md border border-rule bg-surface p-3";
export const legendClass = "px-1 text-sm font-semibold text-ink";
/** A check box or radio with its words, at a full-height target. */
export const checkRow = "flex min-h-11 items-center gap-3 text-base";
export const checkBox = "size-5 shrink-0 accent-action";
