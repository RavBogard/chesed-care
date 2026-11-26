/**
 * "Bring in your list": the pure rules. No database, no model.
 *
 * Splitting: every word of an entry the model proposes must be a word of what was
 * pasted, so nothing invented gets through; without the model the text is split on
 * blank lines, then on line breaks.
 */
import { addDays } from "@/server/lifecycle/window";
import { fold, nameTokens, sameFirstName } from "./name-match";

import { ENTRIES_MAX, ENTRY_MAX, type SplitEntry, type SplitHow, type SplitNote } from "@/lib/bring-in-limits";

export { ENTRIES_MAX, ENTRY_MAX, LIST_MAX, type SplitEntry, type SplitHow, type SplitNote } from "@/lib/bring-in-limits";

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The most words an entry may skip between two runs of the paste's own words. */
const MAX_GAP = 4;
/** An unused stretch of the paste this long becomes an entry of its own. */
const LEFT_OVER_MIN_WORDS = 3;
/** More than this share of the paste's words unused, or of the model's entries rejected, and the model's split is thrown away. */
const MAX_UNUSED_SHARE = 1 / 3;
const MAX_REJECTED_SHARE = 1 / 4;

type Token = { w: string; raw: number; stop: boolean; newline: boolean };

/** The paste as words: each folded word knows which written word it came from, and whether a sentence end or line break follows it. */
function tokenize(input: string): { tokens: Token[]; raws: string[] } {
  const raws: string[] = [];
  const tokens: Token[] = [];
  for (const m of input.matchAll(/(\S+)(\s*)/g)) {
    const text = m[1];
    const newline = m[2].includes("\n");
    const stop = newline || /[.!?;]["')\]]*$/.test(text);
    const words = fold(text).split(" ").filter(Boolean);
    const raw = raws.push(text) - 1;
    if (words.length === 0) {
      const last = tokens[tokens.length - 1];
      if (last) {
        last.stop ||= stop;
        last.newline ||= newline;
      }
      continue;
    }
    words.forEach((w, i) => tokens.push({ w, raw, stop: i === words.length - 1 && stop, newline: i === words.length - 1 && newline }));
  }
  return { tokens, raws };
}

/**
 * Where `words` can be found in the paste, in order, as runs of its own words, using no position in `used`.
 * Between two runs at most MAX_GAP words may be skipped, and the skip may not cross a line break or a sentence end.
 */
function place(stream: readonly Token[], words: readonly string[], used: ReadonlySet<number>): number[] | null {
  for (let start = 0; start < stream.length; start++) {
    if (used.has(start) || stream[start].w !== words[0]) continue;
    const at = [start];
    for (let i = 1; i < words.length; i++) {
      const prev = at[i - 1];
      let found = -1;
      for (let p = prev + 1; p <= prev + 1 + MAX_GAP && p < stream.length; p++) {
        // A gap (p beyond the next word) may not cross a break after any word from `prev` to the one before `p`.
        if (p > prev + 1 && stream.slice(prev, p).some((t) => t.stop)) break;
        if (!used.has(p) && stream[p].w === words[i]) {
          found = p;
          break;
        }
      }
      if (found < 0) break;
      at.push(found);
    }
    if (at.length === words.length) return at;
  }
  return null;
}

/** Text of `text` cut into entries of at most ENTRY_MAX characters, at a space where there is one. The first keeps `note`; the rest are "continued". */
export function chunkEntry(text: string, note?: SplitNote): SplitEntry[] {
  const out: SplitEntry[] = [];
  let rest = text.trim();
  let mark = note;
  while (rest.length > ENTRY_MAX) {
    const space = rest.lastIndexOf(" ", ENTRY_MAX);
    const cut = space > ENTRY_MAX / 2 ? space : ENTRY_MAX;
    out.push({ text: rest.slice(0, cut).trim(), ...(mark ? { note: mark } : {}) });
    rest = rest.slice(cut).trim();
    mark = "continued";
  }
  if (rest) out.push({ text: rest, ...(mark ? { note: mark } : {}) });
  return out;
}

export type Validated = { entries: SplitEntry[]; more: boolean; leftOver: boolean; discard: boolean };

/**
 * The entries the model proposed, kept only where they are made of the paste's own words: in order, in runs
 * (a short gap allowed between runs, never across a line break or sentence end), with each word of the paste
 * used by at most one entry. No word of the paste may silently disappear: every unused stretch of three or more
 * words (not crossing a line break) is added as an entry marked "left over", in paste order. If the model left
 * out more than a third of the words, or more than a quarter of its entries were rejected, the whole split is
 * discarded (`discard`) and the caller uses the plain split.
 */
export function validateSplit(input: string, proposed: readonly { text: string }[]): Validated {
  const { tokens, raws } = tokenize(input);
  const used = new Set<number>();
  const kept: { text: string; first: number }[] = [];
  let rejected = 0;
  for (const p of proposed) {
    const text = clean(typeof p?.text === "string" ? p.text : "");
    const words = fold(text).split(" ").filter(Boolean);
    const at = words.length > 0 && text.length <= ENTRY_MAX ? place(tokens, words, used) : null;
    if (!at) {
      rejected++;
      continue;
    }
    at.forEach((i) => used.add(i));
    kept.push({ text, first: at[0] });
  }
  const unused = tokens.length - used.size;
  const discard = proposed.length === 0 || unused > tokens.length * MAX_UNUSED_SHARE || rejected > proposed.length * MAX_REJECTED_SHARE;
  const parts: { entries: SplitEntry[]; first: number }[] = kept.map((k) => ({ entries: chunkEntry(k.text), first: k.first }));
  let leftOver = false;
  for (let i = 0; i < tokens.length; ) {
    if (used.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < tokens.length && !used.has(j + 1) && !tokens[j].newline) j++;
    if (j - i + 1 >= LEFT_OVER_MIN_WORDS) {
      leftOver = true;
      parts.push({ entries: chunkEntry(raws.slice(tokens[i].raw, tokens[j].raw + 1).join(" "), "left_over"), first: i });
    }
    i = j + 1;
  }
  const entries = parts.sort((x, y) => x.first - y.first).flatMap((x) => x.entries);
  return { entries: entries.slice(0, ENTRIES_MAX), more: entries.length > ENTRIES_MAX, leftOver, discard };
}

/** Control, invisible and direction-changing characters, other than a line break or tab: never in an entry. */
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|\r(?!\n)/;
export const hasBadChars = (s: string) => BAD_CHARS.test(s);

/**
 * Words that always send an entry to the sheet, whatever the model said: a short fixed floor, matched at the
 * start of a word. The model's own "looks sensitive" is a second, separate reason.
 */
const SENSITIVE_FLOOR = /(?<![\p{L}\p{N}])(?:suicid|self[- ]?harm|overdos|abus|assault|addict|rehab|psychiatr|mental health|eating disorder|affair|divorc|arrest|abortion|miscarr|dementia|depress|anxi|bipolar|alcohol|drug|rape|prison|jail|dui|own life|relaps|custody|restraining|evict|bankrupt|foreclos|unemploy|laid off|fired|hiv(?![\p{L}\p{N}]))/iu;
export const touchesSensitiveFloor = (text: string | null | undefined) => !!text && SENSITIVE_FLOOR.test(text.normalize("NFC"));

/** Whether the name as written and the person it matched are the same name: the same words, the first name allowed to be a known nickname. */
export function sameNameExactly(written: string, matched: string): boolean {
  const a = nameTokens(written);
  const b = nameTokens(matched);
  if (a.length === 0 || a.length !== b.length || !sameFirstName(a[0], b[0])) return false;
  return [...a.slice(1)].sort().join(" ") === [...b.slice(1)].sort().join(" ");
}

/** Without the model: blank lines, else line breaks, else the whole text as one entry. An entry over the limit continues in the next. */
export function fallbackSplit(input: string): { entries: SplitEntry[]; how: Exclude<SplitHow, "ai">; more: boolean } {
  const text = input.replace(/\r\n?/g, "\n").trim();
  const pick = (parts: string[]) => parts.map((p) => p.replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, "").trim()).filter(Boolean);
  const blocks = pick(text.split(/\n\s*\n/));
  const lines = pick(text.split(/\n/));
  const [parts, how] = blocks.length > 1 ? ([blocks, "blank_lines"] as const) : lines.length > 1 ? ([lines, "lines"] as const) : ([text ? [text] : [], "one"] as const);
  const entries = parts.flatMap((e) => chunkEntry(clean(e)));
  return { entries: entries.slice(0, ENTRIES_MAX), how, more: entries.length > ENTRIES_MAX };
}

export const LAST_CONTACT = ["today", "week", "month", "longer", "unsure"] as const;
export type LastContact = (typeof LAST_CONTACT)[number];

/** The first follow-up a "last contact was about..." answer suggests: today -> in 2 weeks; this week -> in 1 week; this month -> in 2 days; longer or not sure -> today. */
export function firstFollowUpDue(last: LastContact, today: string): string {
  const days = { today: 14, week: 7, month: 2, longer: 0, unsure: 0 }[last];
  return addDays(today, days);
}

/** Invisible marks that come along with pasted text (direction marks, joiners, byte-order marks, variation selectors): removed, not refused. */
export function stripInvisible(s: string): string {
  return Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0)!;
      return ![0x200e, 0x200f, 0x200d, 0xfeff].includes(c) && !(c >= 0xfe00 && c <= 0xfe0f) && !(c >= 0xe0100 && c <= 0xe01ef);
    })
    .join("");
}
