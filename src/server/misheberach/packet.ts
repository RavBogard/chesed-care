/**
 * The packet document, behind one small interface. Everything that knows the Google Docs shape
 * lives here (locating the Healing Prayers section, building the write batch, describing its shape)
 * and in ./google.ts (the HTTP calls); the sync logic and the tests only see `PacketDoc`.
 *
 * The app reads and writes ONLY the bullet run between the level-2 heading "Healing Prayers" and
 * the line "(end of prayer list)". The italic rule line above the bullets and the bold AV-booth
 * line below them are never touched, and are never read as names even if someone makes them
 * bullets. If the heading or the end line is not found exactly once, nothing is read or written:
 * `PacketSectionNotFound` / `PacketSectionAmbiguous`. A section carrying suggested edits stops the
 * run (`PacketHasSuggestions`). Names and line text are never put in an error message.
 */
import { hasUnsafeLineChars, type PacketLine } from "./line";

export const SECTION_HEADING = "Healing Prayers";
export const SECTION_END = "(end of prayer list)";
/** The start of the italic rule line above the bullets, and of the bold line below them. */
const RULE_LINE_START = "most recent first";
const AV_LINE_START = "please check with av booth";

function named(name: string, message: string): new () => Error {
  return class extends Error {
    constructor() {
      super(message);
      this.name = name;
    }
  };
}
export const PacketNotConnected = named("PacketNotConnected", "The packet is not connected");
export const PacketSectionNotFound = named("PacketSectionNotFound", "The Healing Prayers section was not found");
export const PacketSectionAmbiguous = named("PacketSectionAmbiguous", "The Healing Prayers markers are not unique");
export const PacketStructureUnexpected = named("PacketStructureUnexpected", "The Healing Prayers section has an unexpected shape");
export const PacketLineNotPlainText = named("PacketLineNotPlainText", "A line in the Healing Prayers section holds something other than text");
export const PacketHasSuggestions = named("PacketHasSuggestions", "The Healing Prayers section has suggested edits");
export const PacketChangeTooLarge = named("PacketChangeTooLarge", "The change is larger than the sync will make on its own");
export const PacketRevisionConflict = named("PacketRevisionConflict", "The packet changed while it was being written");
export const PacketRequestFailed = named("PacketRequestFailed", "The packet request failed");

/** One paragraph's place in the document (UTF-16 code units, as the Docs API counts), its end including its newline. */
export type ParagraphSpan = { start: number; end: number };
/**
 * Where the bullets are. `paragraphs` is parallel to `SectionRead.lines`. `insertAt` is where a first
 * bullet goes when there are none (after the rule line, else after the heading). `plainText` is the text
 * style of the nearest plain (not bold) run in the bullets, so inserted text matches it exactly.
 */
export type SectionTarget = { paragraphs: ParagraphSpan[]; insertAt: number; paragraphStyle: Record<string, unknown> | null; plainText: Record<string, unknown> };
export type SectionRead = { revisionId: string; lines: PacketLine[]; target: SectionTarget };
/** What a write changes, by position in the lines that were read (see ./merge.ts). */
export type SectionEdits = { remove: readonly number[]; replace: readonly { index: number; line: PacketLine }[]; insert: readonly { before: number; line: PacketLine }[] };

/** Counts only, for the owner: the shape of the section, never a name. */
export type SectionDescription = {
  bullets: number;
  otherParagraphs: number;
  /** How the bullets' bold runs fall: whole (all bold), name (one run at the start), multiple, other, none. */
  boldShapes: Record<string, number>;
  nesting: Record<string, number>;
  suggestions: boolean;
  ruleLineIsBullet: boolean | null;
  avLineIsBullet: boolean | null;
};

export interface PacketDoc {
  /** The bullets of the Healing Prayers section, with the revision they were read at. */
  read(): Promise<SectionRead>;
  /** Apply `edits` to the section in one atomic write that fails if the document moved on since `read`. */
  write(read: SectionRead, edits: SectionEdits): Promise<void>;
  /** The shape of the section, as counts. */
  describe(): Promise<SectionDescription>;
}

// ─── the part of a Docs document the app looks at ────────────────────────────────────

export type DocTextStyle = { bold?: boolean; italic?: boolean } & Record<string, unknown>;
export type DocElement = {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content?: string; textStyle?: DocTextStyle };
  /** Smart chips staff add as they type: a person (@name), a link to a file or page, a date. */
  person?: { personProperties?: { name?: string; email?: string }; textStyle?: DocTextStyle };
  richLink?: { richLinkProperties?: { title?: string; uri?: string }; textStyle?: DocTextStyle };
  dateElement?: { dateElementProperties?: { displayText?: string }; textStyle?: DocTextStyle };
  pageBreak?: unknown;
  columnBreak?: unknown;
  horizontalRule?: unknown;
};

/** The words a chip shows, or "" for a break (which has no words), or null for something with no words to read (a picture, a footnote mark, an equation). */
function chipWords(el: DocElement): string | null {
  if (el.person) return (el.person.personProperties?.name || el.person.personProperties?.email || "").trim() || null;
  if (el.richLink) return (el.richLink.richLinkProperties?.title || el.richLink.richLinkProperties?.uri || "").trim() || null;
  if (el.dateElement) return (el.dateElement.dateElementProperties?.displayText || "").trim() || null;
  if ("pageBreak" in el || "columnBreak" in el || "horizontalRule" in el) return "";
  return null;
}
export type DocParagraph = { elements?: DocElement[]; paragraphStyle?: { namedStyleType?: string } & Record<string, unknown>; bullet?: { listId?: string; nestingLevel?: number } };
export type DocStructuralElement = { startIndex?: number; endIndex?: number; paragraph?: DocParagraph; table?: unknown };
export type GoogleDocument = { revisionId?: string; body?: { content?: DocStructuralElement[] } };

/**
 * A paragraph's text without its newline, as a person reads it: a chip (a person, a link, a date) reads as
 * the words it shows, set off by a space where the packet has none ("niece of" + chip). This text is for
 * reading and comparing only. Nothing is ever written at a place counted from it: a changed line is
 * replaced whole, by the paragraph's own start and end in the document, so a chip in it becomes plain
 * words then, and a line nobody changes keeps its chip. Something with no words (a picture) is refused.
 */
function paragraphText(p: DocParagraph): { text: string; bold: [number, number][] } {
  let text = "";
  const bold: [number, number][] = [];
  let afterChip = false;
  for (const el of p.elements ?? []) {
    if (!el.textRun) {
      const words = chipWords(el);
      if (words === null) throw new PacketLineNotPlainText();
      if (words === "") continue;
      if (text !== "" && !/[\s(\[]$/.test(text)) text += " ";
      // A chip set in bold (a name typed as @someone) is bold like any other run.
      if ((el.person ?? el.richLink ?? el.dateElement)?.textStyle?.bold === true) bold.push([text.length, text.length + words.length]);
      text += words;
      afterChip = true;
      continue;
    }
    let content = el.textRun.content ?? "";
    if (afterChip && /^[\p{L}\p{N}(]/u.test(content)) content = ` ${content}`;
    afterChip = false;
    if (el.textRun.textStyle?.bold === true) bold.push([text.length, text.length + content.length]);
    text += content;
  }
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { text: trimmed, bold: bold.map(([a, b]) => [Math.min(a, trimmed.length), Math.min(b, trimmed.length)] as [number, number]).filter(([a, b]) => b > a) };
}

const safeText = (p: DocParagraph): string | null => {
  try {
    return paragraphText(p).text.trim();
  } catch {
    return null;
  }
};
const isRule = (text: string | null) => !!text && text.toLowerCase().startsWith(RULE_LINE_START);
const isAv = (text: string | null) => !!text && text.toLowerCase().startsWith(AV_LINE_START);

/** The heading and the end line, each exactly once and in that order, and everything between them. */
function sectionOf(doc: GoogleDocument) {
  const content = doc.body?.content ?? [];
  const paragraphs = content.flatMap((el, i) => (el.paragraph ? [{ el, i, p: el.paragraph }] : []));
  const headings = paragraphs.filter(({ p }) => p.paragraphStyle?.namedStyleType === "HEADING_2" && safeText(p) === SECTION_HEADING);
  // In the real packet a page break shares the end line's paragraph. A break has no words, so the line still reads as itself.
  const ends = paragraphs.filter(({ p }) => safeText(p) === SECTION_END);
  if (headings.length === 0 || ends.length === 0) throw new PacketSectionNotFound();
  if (headings.length > 1 || ends.length > 1) throw new PacketSectionAmbiguous();
  const from = headings[0].i;
  const to = ends[0].i;
  if (to <= from) throw new PacketSectionNotFound();
  return { content, from, to, heading: headings[0].el, between: content.slice(from + 1, to) };
}

/** Suggested edits (tracked changes) anywhere in the section: the document is not in a state the app should write to. */
const SUGGESTION_KEY = /"suggested[A-Za-z]*"/;

const KEPT_PARAGRAPH = ["namedStyleType", "spaceAbove", "spaceBelow", "lineSpacing", "alignment", "direction"] as const;
const KEPT_TEXT = ["fontSize", "weightedFontFamily", "foregroundColor"] as const;

/**
 * Find the section in a document. Stops (throws) rather than guess: the heading and the end line
 * must each occur exactly once, in that order; there must be no suggested edits; and between them
 * the bullets must be one run with nothing but readable bullets in it. Returns the lines and where
 * they sit.
 */
export function locateSection(doc: GoogleDocument): SectionRead {
  const revisionId = doc.revisionId;
  if (!revisionId) throw new PacketStructureUnexpected();
  const { heading, between, content, to } = sectionOf(doc);
  if (SUGGESTION_KEY.test(JSON.stringify([heading, between, content[to]]))) throw new PacketHasSuggestions();
  if (between.some((el) => !el.paragraph)) throw new PacketStructureUnexpected();

  const reserved = between.map((el) => isRule(safeText(el.paragraph!)) || isAv(safeText(el.paragraph!)));
  const candidates = between.flatMap((el, i) => (el.paragraph?.bullet && !reserved[i] ? [i] : []));
  const rule = between.find((el) => isRule(safeText(el.paragraph!)));
  const insertAt = rule?.endIndex ?? heading.endIndex;
  if (insertAt === undefined) throw new PacketStructureUnexpected();
  if (candidates.length === 0) return { revisionId, lines: [], target: { paragraphs: [], insertAt, paragraphStyle: null, plainText: {} } };

  const run = between.slice(candidates[0], candidates[candidates.length - 1] + 1);
  // One unbroken run of bullets: anything else between them (a stray line, the rule or AV line made a bullet) is not for the app to rebuild.
  if (run.some((el, k) => !el.paragraph?.bullet || reserved[candidates[0] + k])) throw new PacketStructureUnexpected();
  const spans = run.map((el) => ({ start: el.startIndex, end: el.endIndex }));
  if (spans.some((s) => s.start === undefined || s.end === undefined || s.end <= s.start)) throw new PacketStructureUnexpected();

  // A page break, column break or rule inside a name's own line has no words, so reading would pass over it, and then a
  // rewrite of that line would delete it and change how the packet prints. Stop instead. (On the end line it is fine: that line is never written.)
  if (run.some((el) => (el.paragraph!.elements ?? []).some((e) => !e.textRun && chipWords(e) === ""))) throw new PacketLineNotPlainText();
  const lines = run.map((el) => paragraphText(el.paragraph!));
  const oldStyle = run[0].paragraph!.paragraphStyle ?? {};
  const paragraphStyle: Record<string, unknown> = {};
  for (const k of KEPT_PARAGRAPH) if (oldStyle[k] !== undefined) paragraphStyle[k] = oldStyle[k];
  // The style a plain run of these bullets has, read from the document: the first run that is not bold.
  const plainRun = run.flatMap((el) => el.paragraph!.elements ?? []).find((e) => e.textRun && e.textRun.textStyle?.bold !== true && (e.textRun.content ?? "").trim() !== "");
  const plainText: Record<string, unknown> = {};
  for (const k of KEPT_TEXT) if (plainRun?.textRun?.textStyle?.[k] !== undefined) plainText[k] = plainRun.textRun.textStyle[k];
  return {
    revisionId,
    lines,
    target: { paragraphs: spans as ParagraphSpan[], insertAt, paragraphStyle: Object.keys(paragraphStyle).length ? paragraphStyle : null, plainText },
  };
}

/** The shape of the section as counts, for the owner. Works on a section that would otherwise be refused (suggestions, odd lines). */
export function describeSection(doc: GoogleDocument): SectionDescription {
  const { between, heading, content, to } = sectionOf(doc);
  const bullets = between.filter((el) => el.paragraph?.bullet);
  const boldShapes: Record<string, number> = {};
  const nesting: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);
  for (const el of bullets) {
    let shape = "other";
    try {
      const { text, bold } = paragraphText(el.paragraph!);
      if (bold.length === 0) shape = "none";
      else if (bold.length > 1) shape = "multiple";
      else if (bold[0][0] === 0 && bold[0][1] >= text.length) shape = "whole";
      else if (bold[0][0] === 0) shape = "name";
    } catch {
      shape = "other";
    }
    bump(boldShapes, shape);
    bump(nesting, String(el.paragraph!.bullet!.nestingLevel ?? 0));
  }
  const rule = between.find((el) => isRule(safeText(el.paragraph ?? {})));
  const av = between.find((el) => isAv(safeText(el.paragraph ?? {})));
  return {
    bullets: bullets.length,
    otherParagraphs: between.length - bullets.length,
    boldShapes,
    nesting,
    suggestions: SUGGESTION_KEY.test(JSON.stringify([heading, between, content[to]])),
    ruleLineIsBullet: rule ? !!rule.paragraph?.bullet : null,
    avLineIsBullet: av ? !!av.paragraph?.bullet : null,
  };
}

/** off: not connected, or switched off. dry-run: the sync reads the packet and says what it would do, and writes nothing. on: it syncs. */
export type SyncMode = "off" | "dry-run" | "on";

export type DocsRequest = Record<string, unknown>;

const TEXT_RESET_FIELDS = "bold,italic,underline,strikethrough,backgroundColor,foregroundColor,link,fontSize,weightedFontFamily";

/** Make inserted text plain exactly like the nearest plain bullet (every field set explicitly, so nothing is inherited from a neighbour), then bold only the name runs. */
function styleRequests(start: number, line: PacketLine, plain: Record<string, unknown>): DocsRequest[] {
  const requests: DocsRequest[] = [{ updateTextStyle: { range: { startIndex: start, endIndex: start + line.text.length }, textStyle: { ...plain, bold: false, italic: false, underline: false, strikethrough: false }, fields: TEXT_RESET_FIELDS } }];
  for (const [a, b] of line.bold) {
    if (a < 0 || b > line.text.length || b <= a) throw new PacketStructureUnexpected();
    requests.push({ updateTextStyle: { range: { startIndex: start + a, endIndex: start + b }, textStyle: { bold: true }, fields: "bold" } });
  }
  return requests;
}

type Op = { anchor: number; rank: 0 | 1; order: number; requests: DocsRequest[] };

/**
 * The one batch for a set of changes, built per paragraph and applied from the end of the document
 * backwards so every earlier index stays valid:
 *  - a removed line: its paragraph is deleted;
 *  - a changed line: the text inside its paragraph is replaced (the paragraph, its bullet and nesting stay);
 *  - a new line: a new bulleted paragraph at its place, copying the paragraph next to it.
 * Untouched paragraphs are not in the batch at all. Every inserted string is checked for characters that
 * must never be written, and every index is checked to lie inside the bullet run (never the rule line,
 * the AV line or the end line); a failure throws before anything is sent.
 */
export function buildWriteRequests(read: SectionRead, edits: SectionEdits): DocsRequest[] {
  const t = read.target;
  const n = t.paragraphs.length;
  const lines = [...edits.replace.map((r) => r.line), ...edits.insert.map((i) => i.line)];
  for (const l of lines) if (hasUnsafeLineChars(l.text) || l.text.trim() === "") throw new PacketStructureUnexpected();
  const limit = n === 0 ? t.insertAt : t.paragraphs[n - 1].end;
  const first = n === 0 ? t.insertAt : t.paragraphs[0].start;
  const inside = (index: number) => {
    if (index < first || index > limit) throw new PacketStructureUnexpected();
    return index;
  };

  if (n === 0) {
    if (edits.remove.length || edits.replace.length) throw new PacketStructureUnexpected();
    if (edits.insert.length === 0) return [];
    // No bullets yet: the first lines go after the rule line (or the heading), made into bullets.
    const text = edits.insert.map((i) => `${i.line.text}\n`).join("");
    const start = inside(t.insertAt);
    const requests: DocsRequest[] = [{ insertText: { location: { index: start }, text } }];
    let at = start;
    for (const { line } of edits.insert) {
      requests.push(...styleRequests(at, line, {}));
      at += line.text.length + 1;
    }
    const range = { startIndex: start, endIndex: start + text.length };
    requests.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
    requests.push({ createParagraphBullets: { range, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    return requests;
  }

  const removed = new Set(edits.remove);
  const replaced = new Map(edits.replace.map((r) => [r.index, r.line]));
  const inserts = edits.insert.map((i) => ({ before: i.before, line: i.line }));
  for (const i of [...removed, ...replaced.keys()]) if (!Number.isInteger(i) || i < 0 || i >= n) throw new PacketStructureUnexpected();
  if (removed.size !== edits.remove.length || [...removed].some((i) => replaced.has(i))) throw new PacketStructureUnexpected();
  for (const ins of inserts) if (!Number.isInteger(ins.before) || ins.before < 0 || ins.before > n) throw new PacketStructureUnexpected();

  // Every bullet is going: the first new lines take the places of the removed paragraphs, so the bullets (and their style) are kept rather than recreated.
  if (inserts.length > 0 && removed.size === n) {
    const gone = [...removed].sort((a, b) => a - b);
    const take = Math.min(gone.length, inserts.length);
    for (let k = 0; k < take; k++) {
      removed.delete(gone[k]);
      replaced.set(gone[k], inserts[k].line);
    }
    inserts.splice(0, take);
    for (const ins of inserts) ins.before = n;
  }
  const lastKept = [...Array(n).keys()].reverse().find((i) => !removed.has(i));
  const nextKept = (from: number) => {
    let j = from;
    while (j < n && removed.has(j)) j++;
    return j;
  };

  const ops: Op[] = [];
  for (const k of removed) ops.push({ anchor: inside(t.paragraphs[k].start), rank: 0, order: 0, requests: [{ deleteContentRange: { range: { startIndex: t.paragraphs[k].start, endIndex: inside(t.paragraphs[k].end) } } }] });
  for (const [k, line] of replaced) {
    const { start, end } = t.paragraphs[k];
    const requests: DocsRequest[] = [];
    if (end - 1 > start) requests.push({ deleteContentRange: { range: { startIndex: inside(start), endIndex: inside(end - 1) } } });
    requests.push({ insertText: { location: { index: inside(start) }, text: line.text } }, ...styleRequests(start, line, t.plainText));
    ops.push({ anchor: start, rank: 0, order: 0, requests });
  }
  inserts.forEach((ins, order) => {
    const j = nextKept(ins.before);
    if (j < n) {
      const start = t.paragraphs[j].start;
      ops.push({ anchor: start, rank: 1, order, requests: [{ insertText: { location: { index: inside(start) }, text: `${ins.line.text}\n` } }, ...styleRequests(start, ins.line, t.plainText)] });
    } else {
      // After the last paragraph that stays: split off its newline, so the new paragraph keeps that paragraph's bullet.
      const m = t.paragraphs[lastKept!];
      const anchor = m.end - 1;
      ops.push({ anchor, rank: 1, order, requests: [{ insertText: { location: { index: inside(anchor) }, text: `\n${ins.line.text}` } }, ...styleRequests(m.end, ins.line, t.plainText)] });
    }
  });
  // From the end backwards. At one place a removal or replacement goes before an insertion, and several insertions go last first, so they read in the order given.
  ops.sort((a, b) => b.anchor - a.anchor || a.rank - b.rank || b.order - a.order);
  return ops.flatMap((o) => o.requests);
}
