/** The message cut into pieces, the ones the AI reading quoted marked. Pure: used to show which words led to what. */
export type Piece = { text: string; marked: boolean };

export function markEvidence(text: string, spans: readonly string[]): Piece[] {
  const ranges: [number, number][] = [];
  for (const span of spans) {
    if (!span) continue;
    const at = text.indexOf(span);
    if (at >= 0) ranges.push([at, at + span.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Piece[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: text.slice(pos, a), marked: false });
    out.push({ text: text.slice(a, b), marked: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), marked: false });
  return out.length ? out : [{ text, marked: false }];
}
