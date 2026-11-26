import type { PacketLine } from "@/server/misheberach/line";
import type { GoogleDocument, SectionEdits } from "@/server/misheberach/packet";
import { SECTION_END, SECTION_HEADING } from "@/server/misheberach/packet";

/** A paragraph of a fake Docs document. `run` is the text style of its plain runs (a colour, a size, a link); `suggested` marks a tracked change. */
export type P = { text: string; style?: string; bullet?: boolean; bold?: [number, number][]; spaceAbove?: number; run?: Record<string, unknown>; nest?: number; suggested?: boolean };

export function makeDoc(paragraphs: P[], revisionId = "rev-1"): GoogleDocument {
  let at = 1;
  const content = paragraphs.map((p) => {
    const startIndex = at;
    const full = `${p.text}\n`;
    const elements: unknown[] = [];
    const cuts = [0, ...(p.bold ?? []).flatMap(([x, y]) => [x, y]), p.text.length, full.length].filter((v, i, arr) => arr.indexOf(v) === i).sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++) {
      const piece = full.slice(cuts[i], cuts[i + 1]);
      const bold = (p.bold ?? []).some(([x, y]) => cuts[i] >= x && cuts[i + 1] <= y);
      elements.push({ startIndex: startIndex + cuts[i], endIndex: startIndex + cuts[i + 1], textRun: { content: piece, textStyle: bold ? { bold: true } : { ...(p.run ?? {}) } }, ...(p.suggested ? { suggestedInsertionIds: ["s1"] } : {}) });
    }
    at += full.length;
    return {
      startIndex,
      endIndex: at,
      paragraph: {
        elements,
        paragraphStyle: { namedStyleType: p.style ?? "NORMAL_TEXT", ...(p.spaceAbove ? { spaceAbove: { magnitude: p.spaceAbove, unit: "PT" } } : {}) },
        ...(p.bullet ? { bullet: { listId: "L1", ...(p.nest ? { nestingLevel: p.nest } : {}) } } : {}),
      },
    };
  });
  return { revisionId, body: { content: content as never } };
}

export const flat = (paragraphs: P[]) => paragraphs.map((p) => `${p.text}\n`).join("");

export const RULE: P = { text: "Most recent first, Names removed after 120 days *Special Requests" };
export const AV: P = { text: "Please check with AV Booth for names said on the stream.", bold: [[0, 20]] };
export const BEFORE: P[] = [{ text: "Announcements", style: "HEADING_2" }, { text: "Something to announce (11/1/26)" }, { text: SECTION_HEADING, style: "HEADING_2" }, RULE];
export const AFTER: P[] = [AV, { text: SECTION_END }, { text: "Yahrzeit List", style: "HEADING_2" }, { text: "Later content" }];
export const bullets = (lines: PacketLine[], extra: Partial<P> = {}): P[] => lines.map((l) => ({ text: l.text, bullet: true, bold: l.bold.map(([x, y]) => [x, y] as [number, number]), spaceAbove: 4, ...extra }));

type Cell = { ch: string; orig: number | null; styled: boolean };

/** Applies the text requests of a batch, in order, to a character model: what text is left, and which original characters were touched by a style request or are new. */
export function simulate(paragraphs: P[], requests: Record<string, unknown>[]) {
  const cells: Cell[] = [...flat(paragraphs)].map((ch, i) => ({ ch, orig: i + 1, styled: false }));
  for (const r of requests) {
    if (r.deleteContentRange) {
      const { startIndex, endIndex } = (r.deleteContentRange as { range: { startIndex: number; endIndex: number } }).range;
      cells.splice(startIndex - 1, endIndex - startIndex);
    } else if (r.insertText) {
      const { location, text } = r.insertText as { location: { index: number }; text: string };
      cells.splice(location.index - 1, 0, ...[...text].map((ch) => ({ ch, orig: null, styled: false })));
    } else if (r.updateTextStyle) {
      const { startIndex, endIndex } = (r.updateTextStyle as { range: { startIndex: number; endIndex: number } }).range;
      for (let i = startIndex - 1; i < endIndex - 1; i++) cells[i].styled = true;
    }
  }
  return { text: cells.map((c) => c.ch).join(""), cells };
}

/** Every original character of paragraph [start, end) is still there, in order, in one piece and untouched by any style request. */
export function untouched(cells: Cell[], start: number, end: number): boolean {
  const at = cells.map((c, i) => (c.orig !== null && c.orig >= start && c.orig < end ? i : -1)).filter((i) => i >= 0);
  if (at.length !== end - start) return false;
  return at.every((pos, k) => (k === 0 || pos === at[k - 1] + 1) && cells[pos].orig === start + k && !cells[pos].styled);
}

/** The lines a packet holds after `edits` (what a faithful write leaves): removals dropped, replacements in place, new lines at their places. */
export function applyEdits(lines: PacketLine[], edits: SectionEdits): PacketLine[] {
  const out: PacketLine[] = [];
  const removed = new Set(edits.remove);
  const replaced = new Map(edits.replace.map((r) => [r.index, r.line]));
  const insertsAt = (i: number) => edits.insert.filter((x) => x.before === i).map((x) => x.line);
  lines.forEach((line, i) => {
    out.push(...insertsAt(i));
    if (!removed.has(i)) out.push(replaced.get(i) ?? line);
  });
  out.push(...insertsAt(lines.length));
  return out.map((l) => ({ text: l.text, bold: l.bold.map(([a, b]) => [a, b] as const) }));
}
