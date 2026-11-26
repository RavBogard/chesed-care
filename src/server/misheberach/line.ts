/**
 * One line of the packet's Healing Prayers list, and its entry. Pure: no database, no network.
 *
 * The line shape (docs/planning/2026-11-24-gap-analysis/MISHEBERACH-SYNC.md): a bullet, the name in
 * bold, then in parentheses a date (M/D/YY or M/D/YYYY), or "included until further notice", or both,
 * then optional free text (", added by X", " friend of X"). Names and line text are never logged.
 */
import { addDays } from "@/server/lifecycle/window";

/** merge.ts still imports addDays under this name. */
export { addDays as addDaysIso };

/** A paragraph of the packet: its text (no trailing newline) and the character ranges set in bold (UTF-16 offsets into `text`). */
export type PacketLine = { text: string; bold: readonly (readonly [number, number])[] };

/** What a packet line says. `date` is YYYY-MM-DD, or null when the line has none. */
export type ParsedLine = { name: string; nameKey: string; date: string | null; standing: boolean; askedBy: string | null; special: boolean };

/** The fields of an entry that appear in a line. */
export type LineFields = { name: string; dateAdded: string; kind: "dated" | "standing"; askedBy: string | null; specialRequest: boolean };

/** Longest name the app takes, whether typed or read from the packet. */
export const NAME_MAX = 120;
export const ASKED_MAX = 200;

/**
 * Characters that never belong in a name or a packet line: C0 controls (except tab, line feed and
 * carriage return, which typed text turns into spaces), DEL, NEL, the line and paragraph separators,
 * bidirectional and zero-width marks (the set the shared validators refuse), private-use code points
 * and unpaired surrogates.
 */
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f\x85]|\p{Cf}|\p{Zl}|\p{Zp}|\p{Co}|\p{Cs}/u;
/** The same, and tab, line feed and carriage return too: a packet line is one paragraph. */
const UNSAFE_IN_LINE = /[\x00-\x1f\x7f\x85]|\p{Cf}|\p{Zl}|\p{Zp}|\p{Co}|\p{Cs}/u;
export const hasUnsafeChars = (s: string): boolean => UNSAFE.test(s);
export const hasUnsafeLineChars = (s: string): boolean => UNSAFE_IN_LINE.test(s);

export const STANDING_PHRASE = "included until further notice";
/** The packet's own rule: dated names come off after this many days. */
export const DATED_DAYS = 120;

/** Left-to-right and right-to-left marks: Hebrew names pasted from other programs carry them. They are ignored when a line is read and when names are compared, and left alone in the packet. */
const DIRECTION_MARKS = new RegExp(`[${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}]`, "g");
const HAS_DIRECTION_MARK = new RegExp(`[${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}]`);

/** The line without those two marks, its bold ranges moved to match. The original is never changed. */
function withoutDirectionMarks(line: PacketLine): PacketLine {
  if (!HAS_DIRECTION_MARK.test(line.text)) return line;
  const removedBefore: number[] = [0];
  for (const ch of line.text) {
    const last = removedBefore[removedBefore.length - 1];
    for (let k = 0; k < ch.length; k++) removedBefore.push(last + (HAS_DIRECTION_MARK.test(ch) ? 1 : 0));
  }
  const shift = (i: number) => i - removedBefore[Math.min(Math.max(i, 0), line.text.length)];
  return { text: line.text.replace(DIRECTION_MARKS, ''), bold: line.bold.map(([a, b]) => [shift(a), shift(b)] as const) };
}

const MARKS = /[‘’ʼʻ׳`´'"“”]/g;
const POINTS = /[̀-֑ͯ-ׇ]/g;

/** The name with case, accents, Hebrew points, apostrophe-like marks, punctuation and spacing removed: how two spellings of one name meet. */
export function nameKey(name: string): string {
  return name
    .replace(DIRECTION_MARKS, "")
    .normalize("NFKD")
    .replace(POINTS, "")
    .toLowerCase()
    .replace(MARKS, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const PAREN = /^\s*\*?\s*\(([^)]*)\)/;
const DATE = /(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/;
const STANDING = /included\s+until\s+further\s+notice/i;

function isoDate(m: number, d: number, y: number): string | null {
  const year = y < 100 ? 2000 + y : y;
  const back = new Date(Date.UTC(year, m - 1, d));
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Where the name ends: the end of the first bold run (adjacent bold pieces and bold spaces joined), else before the first parenthesis. */
function nameSpan(line: PacketLine): { start: number; end: number } {
  const { text } = line;
  const ranges = [...line.bold].map(([a, b]) => [Math.max(0, a), Math.min(text.length, b)] as const).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const first = ranges.find(([a, b]) => text.slice(a, b).trim() !== "");
  if (first) {
    let end = first[1];
    for (const [a, b] of ranges) if (a > first[0] && a <= end) end = Math.max(end, b);
    // A line bold from end to end: the name is what comes before the date or notice in parentheses, not the whole line.
    const inside = text.slice(first[0], end).search(/\s*\*?\s*\([^)]*(?:\d\/\d|until further notice)/i);
    if (inside > 0) end = first[0] + inside;
    return { start: first[0], end };
  }
  const paren = text.search(/\s*\*?\s*\([^)]*(?:\d\/\d|until further notice)/i);
  return { start: 0, end: paren === -1 ? text.length : paren };
}

/** Read one packet line. Null for a blank line. Tolerates stray spaces in or after the bold name, a missing or unfinished requester and the asterisk. */
export function parseLine(original: PacketLine): ParsedLine | null {
  const line = withoutDirectionMarks(original);
  const { text } = line;
  if (hasUnsafeLineChars(text)) return null;
  const { start, end } = nameSpan(line);
  let name = text.slice(start, end).trim();
  let special = false;
  if (/\*+$/.test(name)) {
    special = true;
    name = name.replace(/\*+$/, "").trim();
  }
  if (!name || name.length > NAME_MAX) return null;
  const hadBold = line.bold.some(([a, b]) => b > a && text.slice(Math.max(0, a), Math.min(text.length, b)).trim() !== "");
  let hadParen = false;
  let rest = text.slice(end);
  let date: string | null = null;
  let standing = false;
  const paren = PAREN.exec(rest);
  if (paren && (DATE.test(paren[1]) || STANDING.test(paren[1]))) {
    const d = DATE.exec(paren[1]);
    if (d) date = isoDate(Number(d[1]), Number(d[2]), Number(d[3]));
    standing = STANDING.test(paren[1]);
    if (/\*/.test(paren[0])) special = true;
    rest = rest.slice(paren[0].length);
    hadParen = true;
  }
  if (/\*\s*$/.test(rest)) {
    special = true;
    rest = rest.replace(/\*+\s*$/, "");
  }
  const askedBy = rest.replace(/^[\s,;:\-–—]+/, "").trim().slice(0, ASKED_MAX).trim();
  // Nothing marks this as a list line (no bold name and no date or notice): it is left alone, never read as a name.
  if (!hadBold && !hadParen) return null;
  return { name, nameKey: nameKey(name), date, standing, askedBy: askedBy || null, special };
}

/** `M/D/YY` for a YYYY-MM-DD. */
export function packetDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${String(y % 100).padStart(2, "0")}`;
}

/** The line to write for an entry: the name in bold, the parenthesis, the requester, the asterisk. */
export function formatLine(e: LineFields): PacketLine {
  const name = e.name.trim();
  const inside = [packetDate(e.dateAdded), ...(e.kind === "standing" ? [STANDING_PHRASE] : [])].join(" ");
  const asked = e.askedBy?.trim();
  const rest = asked ? (/^added\s+by\b/i.test(asked) ? `, ${asked}` : ` ${asked}`) : "";
  return { text: `${name} (${inside})${rest}${e.specialRequest ? "*" : ""}`, bold: [[0, name.length]] };
}

/** Whether a parsed line and an entry say the same thing (a line with no date says nothing about the date). */
export function sameFields(p: ParsedLine, e: LineFields): boolean {
  return (
    p.nameKey === nameKey(e.name) &&
    p.name === e.name.trim() &&
    (p.date === null || p.date === e.dateAdded) &&
    p.standing === (e.kind === "standing") &&
    (p.askedBy ?? null) === (e.askedBy?.trim() || null) &&
    p.special === e.specialRequest
  );
}

/** The day a dated entry comes off: 120 days after it was added. */
export const expiresOn = (dateAdded: string, keepUntil: string | null = null): string => {
  const natural = addDays(dateAdded, DATED_DAYS);
  return keepUntil && keepUntil > natural ? keepUntil : natural;
};
