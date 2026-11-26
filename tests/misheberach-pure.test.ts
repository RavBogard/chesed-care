import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGooglePacket, DOCS_SCOPE, normalizeKey, packetConfig, packetFromEnv, signJwt, syncMode, TOKEN_URL } from "@/server/misheberach/google";
import { expiresOn, formatLine, nameKey, parseLine, sameFields, type PacketLine } from "@/server/misheberach/line";
import { mergeSection, reconcileSection, type EntryState, type SnapshotItem } from "@/server/misheberach/merge";
import { brakeCounts, tooLarge } from "@/server/misheberach/sync";
import { buildWriteRequests, describeSection, locateSection, PacketHasSuggestions, PacketLineNotPlainText, PacketRevisionConflict, PacketSectionAmbiguous, PacketSectionNotFound, PacketStructureUnexpected, SECTION_END, SECTION_HEADING } from "@/server/misheberach/packet";
import { AFTER, applyEdits, AV, BEFORE, bullets, flat, makeDoc, RULE, simulate, untouched, type P } from "./support/packet";
import { syncProblem } from "@/lib/misheberach-wording";
import { words } from "./support/words";

const ln = (bold: string, rest = ""): PacketLine => ({ text: bold + rest, bold: [[0, bold.length]] });

describe("the packet line parser", () => {
  it("reads a bold name with a trailing space inside the bold, a two-digit date and a requester", () => {
    const p = parseLine(ln("Ruth Cohen ", "(11/19/26), added by Dana"))!;
    expect(p).toMatchObject({ name: "Ruth Cohen", date: "2026-11-19", standing: false, askedBy: "added by Dana", special: false });
  });
  it("accepts a four-digit year and rejects an impossible date", () => {
    expect(parseLine(ln("Sam Levy", " (3/4/2026) friend of Ruth"))).toMatchObject({ date: "2026-03-04", askedBy: "friend of Ruth" });
    expect(parseLine(ln("Sam Levy", " (2/31/26)"))!.date).toBeNull();
  });
  it("reads 'included until further notice' with and without a date", () => {
    expect(parseLine(ln("Dan Weiss", " (included until further notice)"))).toMatchObject({ standing: true, date: null, askedBy: null });
    expect(parseLine(ln("Dan Weiss", " (7/10/26 included until further notice) brother of Eli"))).toMatchObject({ standing: true, date: "2026-07-10", askedBy: "brother of Eli" });
  });
  it("tolerates a missing, an unfinished and a compound requester, and stray spaces after the bold", () => {
    expect(parseLine(ln("Ann Roth", " (1/2/26)"))!.askedBy).toBeNull();
    expect(parseLine(ln("Ann Roth", " (1/2/26) niece of"))!.askedBy).toBe("niece of");
    expect(parseLine(ln("Ann Roth", "   (1/2/26)  ,  brother of X, added by Y  "))!.askedBy).toBe("brother of X, added by Y");
  });
  it("keeps two people in one entry as one name", () => {
    const p = parseLine(ln("Miriam and Yosef Katz", " (5/5/26)"))!;
    expect(p.name).toBe("Miriam and Yosef Katz");
  });
  it("matches a Hebrew name with an apostrophe-like mark however it is typed", () => {
    const a = parseLine(ln("Ya’akov ben Avraham", " (1/2/26)"))!;
    const b = parseLine(ln("Yaakov ben Avraham", " (1/2/26)"))!;
    const c = parseLine(ln("Ya׳akov ben Avraham", " (1/2/26)"))!;
    expect(a.nameKey).toBe(b.nameKey);
    expect(c.nameKey).toBe(b.nameKey);
    expect(nameKey("יעקב בן אברהם")).toBe("יעקב בן אברהם");
  });
  it("reads the asterisk 'special request' marker wherever it trails", () => {
    expect(parseLine(ln("Eva Stern", " (1/2/26) friend of Z*"))).toMatchObject({ special: true, askedBy: "friend of Z", name: "Eva Stern" });
    expect(parseLine(ln("Eva Stern*", " (1/2/26)"))).toMatchObject({ special: true, name: "Eva Stern" });
    expect(parseLine({ text: "Eva Stern (1/2/26)*", bold: [[0, 9]] })!.special).toBe(true);
  });
  it("reads nothing from a line that is not a list line: no bold name and no date, odd characters, an over-long name", () => {
    expect(parseLine({ text: "Just some words", bold: [] })).toBeNull();
    expect(parseLine({ text: "Noa Peretz", bold: [] })).toBeNull();
    expect(parseLine(ln("AnnRoth", " (1/2/26)"))).toBeNull();
    expect(parseLine(ln("Ann Roth", " (1/2/26) a‮b"))).toBeNull();
    expect(parseLine(ln("N".repeat(121), " (1/2/26)"))).toBeNull();
    expect(parseLine(ln("N".repeat(120), " (1/2/26)"))).not.toBeNull();
    expect(parseLine(ln("Ann Roth", ` (1/2/26) ${"x".repeat(300)}`))!.askedBy).toHaveLength(200);
  });
  it("finds the name without any bold when there is a date, and gives null for a blank line", () => {
    expect(parseLine({ text: "Noa Peretz (1/2/26) added by A", bold: [] })).toMatchObject({ name: "Noa Peretz", date: "2026-01-02" });
    expect(parseLine({ text: "   ", bold: [] })).toBeNull();
  });
  it("writes a line that reads back the same", () => {
    const fields = { name: "Ya’akov ben Avraham", dateAdded: "2026-07-10", kind: "standing" as const, askedBy: "added by Dana", specialRequest: true };
    const line = formatLine(fields);
    expect(line.text).toBe("Ya’akov ben Avraham (7/10/26 included until further notice), added by Dana*");
    expect(line.bold).toEqual([[0, fields.name.length]]);
    expect(sameFields(parseLine(line)!, fields)).toBe(true);
    expect(formatLine({ ...fields, kind: "dated", askedBy: "friend of X", specialRequest: false }).text).toBe("Ya’akov ben Avraham (7/10/26) friend of X");
  });
  it("counts a dated name's 120 days", () => {
    expect(expiresOn("2026-01-01")).toBe("2026-05-01");
  });
});

// ─── the merge ───────────────────────────────────────────────────────────────────────

const TODAY = "2026-11-24";
const entry = (id: string, name: string, over: Partial<EntryState> = {}): EntryState => {
  const e: EntryState = { id, name, nameKey: nameKey(name), dateAdded: "2026-11-01", kind: "dated", askedBy: null, specialRequest: false, consent: "confirmed", docLine: null, ended: false, ...over };
  return { ...e, docLine: over.docLine === undefined ? formatLine(e).text : over.docLine };
};
const snap = (...es: EntryState[]): SnapshotItem[] => es.map((e) => ({ line: e.docLine!, bold: [[0, e.name.length]], entryId: e.id }));
const docOf = (...es: EntryState[]): PacketLine[] => es.map((e) => formatLine(e));
const after = (r: ReturnType<typeof mergeSection>, doc: PacketLine[]) => applyEdits(doc, r.edits).map((l) => l.text);

describe("the three-way merge", () => {
  const a = entry("a", "Ann Roth", { dateAdded: "2026-11-10" });
  const b = entry("b", "Ben Levi", { dateAdded: "2026-11-05" });
  const base = { snapshot: snap(a, b), doc: docOf(a, b), entries: [a, b], firstRun: false, today: TODAY };

  it("an untouched packet and list change nothing and write nothing", () => {
    const r = mergeSection(base);
    expect(r.write).toBe(false);
    expect(r.create).toEqual([]);
    expect(r.end).toEqual([]);
    expect(r.relink).toEqual([]);
  });

  it("never rewrites a line it has no reason to change, however the line is bolded: entries made from the packet, then a second sync with nothing changed writes nothing", () => {
    const shapes: PacketLine[][] = [
      // The whole line in bold.
      [{ text: "Ann Roth (11/10/26) friend of Dana", bold: [[0, 34]] }],
      // Only the first name in bold, so "and Bob" is not part of the name.
      [{ text: "Ann and Bob Roth (11/10/26)", bold: [[0, 3]] }],
      // Two bold names in one entry.
      [{ text: "Ann Roth and Bob Roth (11/10/26)", bold: [[0, 8], [13, 21]] }],
      // No parenthesis at all.
      [{ text: "Ann Roth", bold: [[0, 8]] }, { text: "Ben Levi added by Dana", bold: [[0, 8]] }],
      // A stray space in and after the bold, and the asterisk.
      [{ text: "Ann Roth  (11/10/26)*", bold: [[0, 9]] }],
    ];
    for (const lines of shapes) {
      const first = mergeSection({ snapshot: null, doc: lines, entries: [], firstRun: true, today: TODAY });
      expect(first.create).toHaveLength(lines.length);
      const entries = first.create.map((n, i) => entry(`e${i}`, n.name, { ...n, docLine: n.docLine }));
      const snapshot = first.snapshot.map((s) => ({ line: s.text, bold: s.bold, entryId: "create" in s.ref ? entries[s.ref.create].id : s.ref.id }));
      const second = mergeSection({ snapshot, doc: lines, entries, firstRun: false, today: TODAY });
      expect(second.write, lines[0].text).toBe(false);
      expect(second.edits).toEqual({ remove: [], replace: [], insert: [] });
      expect(second.relink).toEqual([]);
      expect(second.update).toEqual([]);
    }
  });

  it("changes only the one paragraph whose entry field changed", () => {
    const edited = { ...b, askedBy: "friend of Z" };
    const r = mergeSection({ ...base, entries: [a, edited] });
    expect(r.edits).toEqual({ remove: [], insert: [], replace: [{ index: 1, line: formatLine(edited) }] });
  });

  it("a name added in the packet becomes an entry marked not yet confirmed (confirmed on the first run)", () => {
    const added = ln("Cal Dror", " (11/20/26) friend of Ann");
    const doc = [added, ...docOf(a, b)];
    const r = mergeSection({ ...base, doc });
    expect(r.create).toMatchObject([{ name: "Cal Dror", consent: "not_confirmed", dateAdded: "2026-11-20", askedBy: "friend of Ann" }]);
    expect(r.write).toBe(false);
    const first = mergeSection({ snapshot: null, doc, entries: [], firstRun: true, today: TODAY });
    expect(first.create.map((c) => c.consent)).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  it("a line removed in the packet ends the entry, and an app edit made meanwhile does not bring it back", () => {
    const r = mergeSection({ ...base, doc: docOf(a) });
    expect(r.end).toMatchObject([{ id: "b" }]);
    expect(r.write).toBe(false);
    const edited = { ...b, askedBy: "friend of Z" };
    expect(mergeSection({ ...base, entries: [a, edited], doc: docOf(a) }).end).toMatchObject([{ id: "b" }]);
  });

  it("an entry ended in the app is taken out of the packet even if its line was edited there", () => {
    const ended = { ...b, ended: true };
    const r = mergeSection({ ...base, entries: [a, ended] });
    expect(r.edits.remove).toEqual([1]);
    const doc = [...docOf(a), ln("Ben Levi", " (11/05/26) edited")];
    expect(mergeSection({ ...base, entries: [a, ended], doc }).edits.remove).toEqual([1]);
  });

  it("an entry added in the app gets a new line at its sorted place and no other line moves", () => {
    const c = entry("c", "Cal Dror", { dateAdded: "2026-11-23", docLine: null });
    const r = mergeSection({ ...base, entries: [a, b, c] });
    expect(r.edits).toEqual({ remove: [], replace: [], insert: [{ before: 0, line: formatLine(c) }] });
    expect(after(r, base.doc)).toEqual(["Cal Dror (11/23/26)", a.docLine, b.docLine]);
    expect(r.relink).toEqual([{ id: "c", docLine: "Cal Dror (11/23/26)", expect: undefined }]);
    // Older than everything: after the last line. Between two: between them.
    const old = entry("d", "Dee Mor", { dateAdded: "2026-10-01", docLine: null });
    expect(mergeSection({ ...base, entries: [a, b, old] }).edits.insert).toMatchObject([{ before: 2 }]);
    const mid = entry("e", "Eli Ron", { dateAdded: "2026-11-07", docLine: null });
    expect(mergeSection({ ...base, entries: [a, b, mid] }).edits.insert).toMatchObject([{ before: 1 }]);
  });

  it("existing lines are never re-sorted, even out of order in the packet", () => {
    const doc = [formatLine(b), formatLine(a)];
    const r = mergeSection({ ...base, doc, snapshot: snap(b, a) });
    expect(r.write).toBe(false);
  });

  it("standing names stay after the dated ones; a new standing name goes last", () => {
    const s1 = entry("s1", "Sol One", { kind: "standing", dateAdded: "2026-01-01" });
    const c = entry("c", "Cal Dror", { dateAdded: "2026-11-23", docLine: null });
    const s2 = entry("s2", "Sol Two", { kind: "standing", dateAdded: "2026-11-23", docLine: null });
    const doc = [formatLine(a), formatLine(s1)];
    const r = mergeSection({ snapshot: snap(a, s1), doc, entries: [a, s1, c, s2], firstRun: false, today: TODAY });
    expect(after(r, doc)).toEqual([c.docLine ?? formatLine(c).text, a.docLine, s1.docLine, formatLine(s2).text]);
  });

  it("an entry added in the app that the packet already has is linked, the line untouched", () => {
    const c = entry("c", "Cal Dror", { docLine: null });
    const doc = [ln("Cal  Dror", " (11/01/26)"), ...docOf(a, b)];
    const r = mergeSection({ ...base, entries: [a, b, c], doc });
    expect(r.write).toBe(false);
    expect(r.create).toEqual([]);
    // The packet's words stand: its date and who-asked go into the entry, flagged because they differ; the line is not rewritten.
    expect(r.update).toMatchObject([{ id: "c", patch: { dateAdded: "2026-11-01", docLine: "Cal  Dror (11/01/26)" } }]);
  });

  it("the packet's date and who asked go into an entry first linked to its line, flagged only when they differed", () => {
    const c = entry("c", "Cal Dror", { dateAdded: "2026-11-20", askedBy: "friend of Ann", docLine: null });
    const differs = mergeSection({ ...base, entries: [a, b, c], doc: [ln("Cal Dror", " (11/02/26) friend of Bob"), ...docOf(a, b)] });
    expect(differs.update).toMatchObject([{ id: "c", patch: { dateAdded: "2026-11-02", askedBy: "friend of Bob", needsReview: true } }]);
    expect(differs.write).toBe(false);
    const same = mergeSection({ ...base, entries: [a, b, c], doc: [ln("Cal Dror", " (11/20/26) friend of Ann"), ...docOf(a, b)] });
    expect(same.update[0].patch).not.toHaveProperty("needsReview");
    // Next time the entry and the line agree, so nothing is written.
    const linked = { ...c, docLine: "Cal Dror (11/02/26) friend of Bob", dateAdded: "2026-11-02", askedBy: "friend of Bob" };
    const line = ln("Cal Dror", " (11/02/26) friend of Bob");
    expect(mergeSection({ snapshot: [...snap(a, b), { line: line.text, bold: line.bold, entryId: "c" }], doc: [line, ...docOf(a, b)], entries: [a, b, linked], firstRun: false, today: TODAY }).write).toBe(false);
  });

  it("a first link that turns a standing entry into an old dated one flags it and gives a week's grace, so it cannot come off the next morning", () => {
    const c = entry("c", "Cal Dror", { kind: "standing", dateAdded: "2026-11-20", docLine: null });
    const r = mergeSection({ ...base, entries: [a, b, c], doc: [ln("Cal Dror", " (6/01/26)"), ...docOf(a, b)] });
    expect(r.update).toMatchObject([{ id: "c", patch: { kind: "dated", dateAdded: "2026-06-01", needsReview: true, keepUntil: "2026-12-01" } }]);
    // A kind-only difference is a difference too.
    const d = entry("d", "Dov Ezra", { kind: "dated", dateAdded: "2026-11-20", docLine: null });
    const kindOnly = mergeSection({ ...base, entries: [a, b, d], doc: [ln("Dov Ezra", " (11/20/26 included until further notice)"), ...docOf(a, b)] });
    expect(kindOnly.update).toMatchObject([{ id: "d", patch: { kind: "standing", needsReview: true, keepUntil: null } }]);
  });

  it("the brake counts lines removed for someone who asked not to be listed along with every other removal", () => {
    const merged = { end: [], edits: { replace: [] }, counts: { removedFromPacket: 2, removedBarred: 2 } } as unknown as ReturnType<typeof mergeSection>;
    expect(brakeCounts({ live: 9, lines: 9, merged }).wouldRemoveLines).toBe(4);
    expect(tooLarge({ live: 9, lines: 9, merged })).not.toBeNull();
    const one = { end: [], edits: { replace: [] }, counts: { removedFromPacket: 0, removedBarred: 1 } } as unknown as ReturnType<typeof mergeSection>;
    expect(tooLarge({ live: 9, lines: 9, merged: one })).toBeNull();
  });

  it("an override entry for someone who asked not to be listed takes a hand-typed line as its own: never a second line", () => {
    const tomb = entry("t", "Gil Amir", { ended: true, consent: "asked_not_listed" });
    const over = entry("o", "Gil Amir", { dateAdded: "2026-11-24", docLine: null });
    const doc = [ln("Gil Amir", " (11/24/26)"), ...docOf(a, b)];
    const r = mergeSection({ ...base, entries: [a, b, tomb, over], doc });
    expect(r.write).toBe(false);
    expect(r.counts.blocked).toBe(0);
    expect(r.edits).toEqual({ remove: [], replace: [], insert: [] });
    expect(r.snapshot.filter((x) => "id" in x.ref && x.ref.id === "o")).toHaveLength(1);
  });

  it("a change in which text is bold, and nothing else, rewrites nothing and changes nothing", () => {
    const lines: PacketLine[] = [{ text: "Ann Roth (11/10/26)", bold: [[0, 3]] }];
    const first = mergeSection({ snapshot: null, doc: lines, entries: [], firstRun: true, today: TODAY });
    const entries = first.create.map((n, i) => entry(`e${i}`, n.name, { ...n }));
    const snapshot = first.snapshot.map((s) => ({ line: s.text, bold: s.bold, entryId: entries[(s.ref as { create: number }).create].id }));
    const widened: PacketLine[] = [{ text: "Ann Roth (11/10/26)", bold: [[0, 19]] }];
    const r = mergeSection({ snapshot, doc: widened, entries, firstRun: false, today: TODAY });
    expect(r.write).toBe(false);
    expect(r.update).toEqual([]);
    expect(r.relink).toEqual([]);
    // And the next run, reading the same way, still changes nothing.
    const again = mergeSection({ snapshot: r.snapshot.map((s) => ({ line: s.text, bold: s.bold, entryId: "e0" })), doc: widened, entries, firstRun: false, today: TODAY });
    expect(again.write).toBe(false);
    expect(again.update).toEqual([]);
  });

  it("reads Hebrew names with left-to-right and right-to-left marks, leaves their text alone, and still refuses the other direction controls", () => {
    const RLM = String.fromCharCode(0x200f);
    const LRM = String.fromCharCode(0x200e);
    const marked = { text: `Ya${RLM}akov ben Avraham${LRM} (1/2/26)`, bold: [[0, 20]] as [number, number][] };
    const plain = parseLine({ text: "Yaakov ben Avraham (1/2/26)", bold: [[0, 18]] })!;
    const read = parseLine(marked)!;
    expect(read).toMatchObject({ date: "2026-01-02", name: "Yaakov ben Avraham" });
    expect(read.nameKey).toBe(plain.nameKey);
    expect(nameKey(`Ya${RLM}akov`)).toBe(nameKey("Yaakov"));
    const first = mergeSection({ snapshot: null, doc: [marked], entries: [], firstRun: true, today: TODAY });
    expect(first.create).toHaveLength(1);
    expect(first.snapshot[0].text).toBe(marked.text);
    expect(first.create[0].docLine).toBe(marked.text);
    expect(parseLine({ text: `Ann${String.fromCharCode(0x202e)}Roth (1/2/26)`, bold: [[0, 8]] })).toBeNull();
    expect(parseLine({ text: `Ann${String.fromCharCode(0x200b)}Roth (1/2/26)`, bold: [[0, 8]] })).toBeNull();
  });

  it("a line bold from end to end has its name taken before the date, not the whole line", () => {
    expect(parseLine({ text: "Ann Roth (11/10/26) friend of Dana", bold: [[0, 34]] })).toMatchObject({ name: "Ann Roth", date: "2026-11-10", askedBy: "friend of Dana" });
    expect(parseLine({ text: "Dan Weiss (included until further notice)", bold: [[0, 41]] })).toMatchObject({ name: "Dan Weiss", standing: true });
    expect(parseLine({ text: "Ann (nee Roth) Levi", bold: [[0, 19]] })).toMatchObject({ name: "Ann (nee Roth) Levi", date: null });
  });

  it("takes the lines of people who asked not to be listed out of the packet only when asked", () => {
    const gone = entry("g", "Gil Amir", { ended: true, consent: "asked_not_listed" });
    const doc = [ln("Gil Amir", " (11/22/26)"), ...docOf(a, b)];
    expect(mergeSection({ ...base, entries: [a, b, gone], doc }).edits.remove).toEqual([]);
    const r = mergeSection({ ...base, entries: [a, b, gone], doc, removeBarred: true });
    expect(r.edits.remove).toEqual([0]);
    expect(r.counts.removedBarred).toBe(1);
    expect(r.counts.blocked).toBe(0);
  });

  it("a line edited in the packet updates the same entry when the name still matches, and the line stays as typed", () => {
    const doc = [ln("Ann Roth", " (11/10/26) friend of Dana"), formatLine(b)];
    const r = mergeSection({ ...base, doc });
    expect(r.update).toMatchObject([{ id: "a", patch: { askedBy: "friend of Dana", docLine: "Ann Roth (11/10/26) friend of Dana" } }]);
    expect(r.write).toBe(false);
  });

  it("a line retyped as another name is remove plus add, flagged for a person to look at", () => {
    const doc = [formatLine(a), ln("Benjamin Roth", " (11/05/26)")];
    const r = mergeSection({ ...base, doc });
    expect(r.end).toMatchObject([{ id: "b" }]);
    expect(r.create).toMatchObject([{ name: "Benjamin Roth", needsReview: true }]);
  });

  it("edits on both sides keep the packet's words and ask a person to look", () => {
    const appEdit = { ...b, askedBy: "friend of Z" };
    const both = mergeSection({ ...base, entries: [a, appEdit], doc: [formatLine(a), ln("Ben Levi", " (11/05/26) niece of Q")] });
    expect(both.update).toMatchObject([{ id: "b", patch: { askedBy: "niece of Q", needsReview: true } }]);
    expect(both.write).toBe(false);
  });

  it("someone who asked not to be listed gets no entry from the packet, and the line is left exactly where it is", () => {
    const gone = entry("g", "Gil Amir", { ended: true, consent: "asked_not_listed" });
    const doc = [ln("Gil Amir", " (11/22/26)"), ...docOf(a, b)];
    const r = mergeSection({ ...base, entries: [a, b, gone], doc });
    expect(r.create).toEqual([]);
    expect(r.counts.blocked).toBe(1);
    expect(r.write).toBe(false);
    expect(r.plan.leftAlone).toEqual([{ text: "Gil Amir (11/22/26)", why: "asked_not_listed" }]);
  });

  it("a duplicate line for one name is kept verbatim in place, with no entry, and counted", () => {
    const dup = ln("Ann Roth", " (11/12/26) a different Ann");
    const doc = [...docOf(a, b), dup];
    const r = mergeSection({ ...base, doc });
    expect(r.write).toBe(false);
    expect(r.create).toEqual([]);
    expect(r.counts.duplicates).toBe(1);
    // Even when the first copy goes, the second is not dropped and not made an entry.
    const gone = mergeSection({ ...base, entries: [{ ...a, ended: true }, b], doc });
    expect(gone.edits.remove).toEqual([0]);
    expect(gone.create).toEqual([]);
    expect(gone.counts.duplicates).toBe(1);
  });

  it("carries a line it cannot read exactly where it is: a blank bullet, a line with no bold name and no date, odd characters, an over-long name", () => {
    const odd: PacketLine[] = [{ text: "", bold: [] }, { text: "Just some words with no date", bold: [] }, ln("Ann\u0007Roth", " (1/2/26)"), ln("N".repeat(121), " (1/2/26)")];
    const doc = [odd[0], ...docOf(a), odd[1], odd[2], odd[3], ...docOf(b)];
    const c = entry("c", "Cal Dror", { dateAdded: "2026-11-23", docLine: null });
    const r = mergeSection({ ...base, entries: [a, b, c], doc });
    expect(r.counts.leftAlone).toBe(4);
    expect(r.create).toEqual([]);
    const result = after(r, doc);
    expect(result.filter((t) => odd.some((o) => o.text === t))).toEqual(odd.map((o) => o.text));
    expect(r.edits.remove).toEqual([]);
    expect(r.edits.replace).toEqual([]);
  });

  it("imports a name whose 120 days are up (or nearly) with a week's grace and the prompt, not an instant removal", () => {
    const old = ln("Old Name", " (1/2/26)");
    const near = ln("Near Name", " (7/30/26)");
    const fine = ln("Fresh Name", " (11/20/26)");
    const stand = ln("Standing Name", " (included until further notice)");
    const r = mergeSection({ snapshot: null, doc: [old, near, fine, stand], entries: [], firstRun: true, today: TODAY });
    expect(r.create.map((c) => [c.name, c.keepUntil])).toEqual([
      ["Old Name", "2026-12-01"],
      ["Near Name", "2026-12-01"],
      ["Fresh Name", null],
      ["Standing Name", null],
    ]);
  });

  it("reconcile pairs a line with an ENDED entry only when it is exactly that entry's last line; any other line is a new name, unless barred", () => {
    const exact = entry("x", "Gone Name", { ended: true });
    const retyped = entry("y", "Other Gone", { ended: true, docLine: "Other Gone (1/1/26)" });
    const tomb = entry("t", "Gil Amir", { ended: true, consent: "asked_not_listed", docLine: "Gil Amir (1/1/26)" });
    const doc = [formatLine(exact), ln("Other Gone", " (11/20/26) typed again"), ln("Gil Amir", " (11/21/26) typed again")];
    const rec = reconcileSection({ doc, entries: [exact, retyped, tomb], today: TODAY });
    expect(rec.counts).toMatchObject({ stillInPacket: 1, created: 1, blocked: 1 });
    expect(rec.create).toMatchObject([{ name: "Other Gone" }]);
    expect(rec.snapshot.filter((s) => "id" in s.ref).map((s) => (s.ref as { id: string }).id)).toEqual(["x"]);
  });

  it("reconcile takes the packet's date and who-asked into a live entry it matches, flagged when they differed", () => {
    const live = entry("l", "Live Name", { dateAdded: "2026-11-20", askedBy: "friend of Ann", docLine: "Live Name (11/20/26) friend of Ann" });
    const rec = reconcileSection({ doc: [ln("Live Name", " (11/02/26) friend of Bob")], entries: [live], today: TODAY });
    expect(rec.update).toMatchObject([{ id: "l", patch: { dateAdded: "2026-11-02", askedBy: "friend of Bob", needsReview: true } }]);
  });

  it("a lost snapshot is reconciled read-only: nothing written, nothing ended, nothing resurrected", () => {
    const ended = entry("x", "Gone Name", { ended: true });
    const lonely = entry("l", "Lonely Name");
    const doc = [formatLine(a), formatLine(ended), ln("Brand New", " (11/20/26)")];
    const rec = reconcileSection({ doc, entries: [a, ended, lonely], today: TODAY });
    expect(rec.counts).toMatchObject({ matched: 1, created: 1, stillInPacket: 1, notInPacket: 1 });
    expect(rec.create).toMatchObject([{ name: "Brand New", consent: "not_confirmed" }]);
    expect(rec.plan.leftAlone).toEqual([{ text: formatLine(ended).text, why: "ended_in_app" }]);
    // The ended name is paired with its ended entry, so it can never become a new entry.
    expect(rec.snapshot.filter((s) => "id" in s.ref).map((s) => (s.ref as { id: string }).id).sort()).toEqual(["a", "l", "x"]);
  });
});

// ─── the document ────────────────────────────────────────────────────────────────────

describe("locating the Healing Prayers section", () => {
  const items = [ln("Ann Roth", " (11/10/26) friend of Dana"), ln("Ben Levi ", "(included until further notice)")];
  const doc = makeDoc([...BEFORE, ...bullets(items, { run: { fontSize: { magnitude: 11, unit: "PT" } } }), ...AFTER]);

  it("reads the bullets between the heading and the end line, with their bold, their places and the revision", () => {
    const read = locateSection(doc);
    expect(read.revisionId).toBe("rev-1");
    expect(read.lines.map((l) => l.text)).toEqual(items.map((l) => l.text));
    expect(read.lines[0].bold).toEqual([[0, 8]]);
    expect(read.target.paragraphs).toHaveLength(2);
    expect(read.target.paragraphStyle).toMatchObject({ namedStyleType: "NORMAL_TEXT", spaceAbove: { magnitude: 4, unit: "PT" } });
    expect(read.target.plainText).toEqual({ fontSize: { magnitude: 11, unit: "PT" } });
  });

  it("stops when the heading or the end line is missing or appears twice", () => {
    expect(() => locateSection(makeDoc([...BEFORE, ...bullets(items)]))).toThrow(PacketSectionNotFound);
    expect(() => locateSection(makeDoc([{ text: "Nothing" }, ...AFTER]))).toThrow(PacketSectionNotFound);
    expect(() => locateSection(makeDoc([...BEFORE, { text: SECTION_HEADING, style: "HEADING_2" }, ...bullets(items), ...AFTER]))).toThrow(PacketSectionAmbiguous);
    expect(() => locateSection(makeDoc([...BEFORE, ...bullets(items), ...AFTER, { text: SECTION_END }]))).toThrow(PacketSectionAmbiguous);
    expect(() => locateSection(makeDoc([{ text: SECTION_HEADING }, ...bullets(items), ...AFTER]))).toThrow(PacketSectionNotFound);
  });

  it("finds the end line when a page break shares its paragraph, as in the real packet", () => {
    const doc = makeDoc([...BEFORE, ...bullets(items), ...AFTER]);
    const end = doc.body!.content!.find((el) => el.paragraph?.elements?.some((e) => e.textRun?.content?.startsWith(SECTION_END)))!;
    end.paragraph!.elements!.splice(1, 0, { pageBreak: {} } as never);
    expect(locateSection(doc).lines).toHaveLength(items.length);
  });

  it("reads a chip staff added (a person, a link, a date) as the words it shows", () => {
    const doc = makeDoc([...BEFORE, ...bullets(items), ...AFTER]);
    const plain = locateSection(doc).lines[0];
    const bullet = doc.body!.content!.find((el) => el.paragraph?.bullet)!;
    const els = bullet.paragraph!.elements!;
    const newline = els.pop()!;
    // As in the real packet: "…, niece of" with no space, then the chip, then the paragraph's newline.
    els.push({ textRun: { content: ", niece of" } }, { person: { personProperties: { name: "Dana Cohen", email: "dana@example.org" } } }, { textRun: { content: "and" } }, { richLink: { richLinkProperties: { title: "A page" } } }, { dateElement: { dateElementProperties: { displayText: "Nov 25" } } }, { textRun: { content: "." } });
    els.push(newline.textRun?.content === "\n" ? newline : { textRun: { content: "\n" } });
    const read = locateSection(doc).lines[0];
    expect(read.text.endsWith(", niece of Dana Cohen and A page Nov 25.")).toBe(true);
    // The name is still the only bold run, at the start.
    expect(read.bold).toEqual(plain.bold);
  });

  it("stops, by its own name, on a line holding something with no words", () => {
    const doc = makeDoc([...BEFORE, ...bullets(items), ...AFTER]);
    const bullet = doc.body!.content!.find((el) => el.paragraph?.bullet)!;
    bullet.paragraph!.elements!.unshift({ inlineObjectElement: { inlineObjectId: "x" } } as never);
    expect(() => locateSection(doc)).toThrow(PacketLineNotPlainText);
    expect(syncProblem("PacketLineNotPlainText")).toMatch(/cannot be read as words/);
  });

  it("stops on a page break inside a name's own line, which a rewrite would delete", () => {
    const doc = makeDoc([...BEFORE, ...bullets(items), ...AFTER]);
    const last = doc.body!.content!.filter((el) => el.paragraph?.bullet).at(-1)!;
    last.paragraph!.elements!.splice(-1, 0, { pageBreak: {} });
    expect(() => locateSection(doc)).toThrow(PacketLineNotPlainText);
  });

  it("reads a bold chip as bold, and puts no space after an opening bracket", () => {
    const doc = makeDoc([...BEFORE, ...bullets(items), ...AFTER]);
    const bullet = doc.body!.content!.find((el) => el.paragraph?.bullet)!;
    bullet.paragraph!.elements = [{ person: { personProperties: { name: "Dana Cohen" }, textStyle: { bold: true } } }, { textRun: { content: " (" } }, { dateElement: { dateElementProperties: { displayText: "11/1/26" } } }, { textRun: { content: ")\n" } }];
    expect(locateSection(doc).lines[0]).toEqual({ text: "Dana Cohen (11/1/26)", bold: [[0, 10]] });
  });

  it("stops on a bullet run with something else in the middle", () => {
    const broken = makeDoc([...BEFORE, ...bullets([items[0]]), { text: "stray words" }, ...bullets([items[1]]), ...AFTER]);
    expect(() => locateSection(broken)).toThrow(PacketStructureUnexpected);
  });

  it("never reads the rule line or the AV line as a name, even made into bullets", () => {
    const made = makeDoc([...BEFORE.slice(0, 3), { ...RULE, bullet: true }, ...bullets(items), { ...AV, bullet: true }, ...AFTER.slice(1)]);
    const read = locateSection(made);
    expect(read.lines.map((l) => l.text)).toEqual(items.map((l) => l.text));
    // In the middle of the run they stop the run instead.
    expect(() => locateSection(makeDoc([...BEFORE, ...bullets([items[0]]), { ...AV, bullet: true }, ...bullets([items[1]]), ...AFTER]))).toThrow(PacketStructureUnexpected);
  });

  it("stops when the section carries suggested edits", () => {
    expect(() => locateSection(makeDoc([...BEFORE, ...bullets([items[0]]), ...bullets([items[1]], { suggested: true }), ...AFTER]))).toThrow(PacketHasSuggestions);
  });

  it("finds where a first bullet goes when there are none: after the rule line, else after the heading", () => {
    const withRule = makeDoc([...BEFORE, ...AFTER]);
    const read = locateSection(withRule);
    expect(read.lines).toEqual([]);
    const ruleEnd = withRule.body!.content!.find((el) => el.paragraph?.elements?.[0].textRun?.content?.startsWith("Most recent"))!.endIndex;
    expect(read.target.insertAt).toBe(ruleEnd);
    const noRule = makeDoc([...BEFORE.slice(0, 3), ...AFTER]);
    expect(locateSection(noRule).target.insertAt).toBe(noRule.body!.content![2].endIndex);
  });

  it("describes the section as counts only", () => {
    const shaped = makeDoc([...BEFORE, ...bullets([ln("Whole line", " (1/2/26)"), { text: "Whole", bold: [[0, 5]] }, { text: "A and B", bold: [[0, 1], [6, 7]] }, { text: "no bold", bold: [] }], { nest: 1 }), ...AFTER]);
    const d = describeSection(shaped);
    expect(d).toEqual({ bullets: 4, otherParagraphs: 2, boldShapes: { name: 1, whole: 1, multiple: 1, none: 1 }, nesting: { "1": 4 }, suggestions: false, ruleLineIsBullet: false, avLineIsBullet: false });
    expect(describeSection(makeDoc([...BEFORE, ...bullets([items[0]], { suggested: true }), ...AFTER])).suggestions).toBe(true);
    expect(words(d)).not.toMatch(/Whole|Ann/);
  });
});

describe("the write batch", () => {
  const old = [ln("Ann Roth", " (11/10/26) friend of Dana"), ln("Ben Levi", " (10/1/26)"), ln("Cal Dror", " (9/1/26)"), ln("Dee Mor", " (8/1/26)")];
  const paragraphs: P[] = [...BEFORE, ...bullets(old, { run: { foregroundColor: { color: { rgbColor: { red: 0.2 } } }, fontSize: { magnitude: 11, unit: "PT" } } }), ...AFTER];
  const read = locateSection(makeDoc(paragraphs));
  const spans = read.target.paragraphs;
  const flatLines = (edits: Parameters<typeof buildWriteRequests>[1]) => applyEdits(read.lines, edits).map((l) => l.text);

  it("deletes a removed line's paragraph, replaces a changed line inside its paragraph and inserts a new one, and every other paragraph is byte-identical", () => {
    const edits = {
      remove: [1],
      replace: [{ index: 3, line: ln("Dee Mor", " (8/1/26) niece of Q") }],
      insert: [{ before: 0, line: ln("Eve New", " (11/23/26)") }, { before: 4, line: ln("Fay Last", " (included until further notice)") }],
    };
    const requests = buildWriteRequests(read, edits);
    const sim = simulate(paragraphs, requests);
    const expected = [...BEFORE, ...[ln("Eve New", " (11/23/26)"), old[0], old[2], ln("Dee Mor", " (8/1/26) niece of Q"), ln("Fay Last", " (included until further notice)")].map((l) => ({ text: l.text })), ...AFTER];
    expect(sim.text).toBe(flat(expected));
    // Everything outside the run, and the two paragraphs that were not edited, are untouched characters with untouched styles.
    expect(untouched(sim.cells, 1, spans[0].start)).toBe(true);
    expect(untouched(sim.cells, spans[0].start, spans[0].end)).toBe(true);
    expect(untouched(sim.cells, spans[2].start, spans[2].end)).toBe(true);
    expect(untouched(sim.cells, spans[3].end, flat(paragraphs).length + 1)).toBe(true);
    expect(flatLines(edits)).toEqual(["Eve New (11/23/26)", old[0].text, old[2].text, "Dee Mor (8/1/26) niece of Q", "Fay Last (included until further notice)"]);
  });

  it("builds nothing for paragraphs it does not touch, and works from the end of the document backwards", () => {
    const requests = buildWriteRequests(read, { remove: [], replace: [{ index: 1, line: ln("Ben Levi", " (10/1/26) edited") }], insert: [] });
    const starts = requests.flatMap((r) => Object.values(r).map((v) => (v as { range?: { startIndex: number }; location?: { index: number } }).range?.startIndex ?? (v as { location?: { index: number } }).location?.index)).filter((v): v is number => v !== undefined);
    expect(Math.min(...starts)).toBe(spans[1].start);
    expect(Math.max(...starts)).toBeLessThan(spans[2].start);
    const many = buildWriteRequests(read, { remove: [0, 2], replace: [], insert: [] });
    const deletes = many.map((r) => (r.deleteContentRange as { range: { startIndex: number } }).range.startIndex);
    expect(deletes).toEqual([spans[2].start, spans[0].start]);
  });

  it("resets inherited text style fully, matching the nearest plain bullet read from the document, and bolds only the name", () => {
    const line = ln("Eve New", " (11/23/26)");
    const requests = buildWriteRequests(read, { remove: [], replace: [], insert: [{ before: 1, line }] });
    const sim = simulate(paragraphs, requests);
    const styles = requests.filter((r) => r.updateTextStyle).map((r) => r.updateTextStyle as { range: { startIndex: number; endIndex: number }; textStyle: Record<string, unknown>; fields: string });
    const plain = styles[0];
    expect(plain.textStyle).toMatchObject({ bold: false, italic: false, underline: false, strikethrough: false, fontSize: { magnitude: 11, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.2 } } } });
    for (const f of ["bold", "italic", "underline", "strikethrough", "backgroundColor", "link", "foregroundColor", "fontSize"]) expect(plain.fields).toContain(f);
    expect(styles[1]).toMatchObject({ textStyle: { bold: true }, fields: "bold" });
    expect(sim.text.slice(styles[1].range.startIndex - 1, styles[1].range.endIndex - 1)).toBe("Eve New");
    expect(styles).toHaveLength(2);
  });

  it("replaces every bullet in place when all of them go and new ones come, so the bullets are kept", () => {
    const edits = { remove: [0, 1, 2, 3], replace: [], insert: [{ before: 0, line: ln("Only New", " (11/23/26)") }] };
    const sim = simulate(paragraphs, buildWriteRequests(read, edits));
    expect(sim.text).toBe(flat([...BEFORE, { text: "Only New (11/23/26)" }, ...AFTER]));
  });

  it("puts a first bullet after the rule line as a bullet when there are none", () => {
    const bare: P[] = [...BEFORE, ...AFTER];
    const bareRead = locateSection(makeDoc(bare));
    const requests = buildWriteRequests(bareRead, { remove: [], replace: [], insert: [{ before: 0, line: ln("Eve New", " (11/23/26)") }, { before: 0, line: ln("Fay Next", " (11/22/26)") }] });
    expect(simulate(bare, requests).text).toBe(flat([...BEFORE, { text: "Eve New (11/23/26)" }, { text: "Fay Next (11/22/26)" }, ...AFTER]));
    const bullet = requests.find((r) => r.createParagraphBullets) as { createParagraphBullets: { range: { startIndex: number } } };
    expect(bullet.createParagraphBullets.range.startIndex).toBe(bareRead.target.insertAt);
  });

  it("refuses, before anything is sent, text that must never be written and any index outside the bullet run", () => {
    const bad = (text: string) => () => buildWriteRequests(read, { remove: [], replace: [], insert: [{ before: 0, line: { text, bold: [[0, 3]] } }] });
    expect(bad("Eve\u0007 New (1/2/26)")).toThrow(PacketStructureUnexpected);
    expect(bad("Eve\nNew (1/2/26)")).toThrow(PacketStructureUnexpected);
    expect(bad("Eve‮New (1/2/26)")).toThrow(PacketStructureUnexpected);
    expect(bad("EveNew (1/2/26)")).toThrow(PacketStructureUnexpected);
    expect(bad("Eve\ud800New (1/2/26)")).toThrow(PacketStructureUnexpected);
    expect(bad("   ")).toThrow(PacketStructureUnexpected);
    expect(() => buildWriteRequests(read, { remove: [4], replace: [], insert: [] })).toThrow(PacketStructureUnexpected);
    expect(() => buildWriteRequests(read, { remove: [], replace: [], insert: [{ before: 5, line: ln("Eve New", " (1/2/26)") }] })).toThrow(PacketStructureUnexpected);
    expect(() => buildWriteRequests(read, { remove: [1], replace: [{ index: 1, line: ln("Ben Levi", " (1/2/26)") }], insert: [] })).toThrow(PacketStructureUnexpected);
    // No request, in a good batch, reaches past the end of the run (the AV line and the end line follow it).
    const requests = buildWriteRequests(read, { remove: [3], replace: [], insert: [{ before: 4, line: ln("Fay Last", " (1/2/26)") }] });
    const ends = requests.flatMap((r) => (r.deleteContentRange ? [(r.deleteContentRange as { range: { endIndex: number } }).range.endIndex] : r.insertText ? [(r.insertText as { location: { index: number } }).location.index] : []));
    expect(Math.max(...ends)).toBeLessThanOrEqual(spans[3].end);
  });
});

// ─── Google ──────────────────────────────────────────────────────────────────────────

describe("Google access", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

  it("signs an RS256 assertion whose header, claims and signature verify with the public key", () => {
    const jwt = signJwt({ email: "care@project.iam.example", key: privateKey }, 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "care@project.iam.example", scope: DOCS_SCOPE, aud: TOKEN_URL, iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(createPublicKey(publicKey), Buffer.from(s, "base64url"))).toBe(true);
  });

  it("accepts the key with real newlines, with escaped newlines, and wrapped in quotes; the document id must look like one", () => {
    const escaped = privateKey.replace(/\n/g, "\\n");
    for (const raw of [privateKey, escaped, `"${escaped}"`]) {
      expect(normalizeKey(raw)).toBe(privateKey.trim());
      expect(() => signJwt({ email: "e", key: normalizeKey(raw) }, 1)).not.toThrow();
    }
    const env = { MISHEBERACH_DOC_ID: DOC, GOOGLE_SERVICE_ACCOUNT_EMAIL: "e@x", GOOGLE_SERVICE_ACCOUNT_KEY: escaped };
    expect(packetConfig(env)).toMatchObject({ docId: DOC, email: "e@x", key: privateKey.trim() });
    expect(packetConfig({ ...env, MISHEBERACH_DOC_ID: "short" })).toBeNull();
    expect(packetConfig({ ...env, MISHEBERACH_DOC_ID: `${DOC}/../x` })).toBeNull();
    expect(packetConfig({ MISHEBERACH_DOC_ID: DOC, GOOGLE_SERVICE_ACCOUNT_EMAIL: "e@x" })).toBeNull();
    expect(packetConfig({})).toBeNull();
  });

  it("the sync mode: off when not configured, trial (dry-run) by default once configured, on only when asked", () => {
    const env = { MISHEBERACH_DOC_ID: DOC, GOOGLE_SERVICE_ACCOUNT_EMAIL: "e@x", GOOGLE_SERVICE_ACCOUNT_KEY: privateKey };
    expect(syncMode({})).toBe("off");
    expect(syncMode({ MISHEBERACH_SYNC_MODE: "on" })).toBe("off");
    expect(syncMode(env)).toBe("dry-run");
    expect(syncMode({ ...env, MISHEBERACH_SYNC_MODE: "nonsense" })).toBe("dry-run");
    expect(syncMode({ ...env, MISHEBERACH_SYNC_MODE: " ON " })).toBe("on");
    expect(syncMode({ ...env, MISHEBERACH_SYNC_MODE: "off" })).toBe("off");
    expect(packetFromEnv({ ...env, MISHEBERACH_SYNC_MODE: "off" })).toBeNull();
    expect(packetFromEnv(env)).not.toBeNull();
  });

  it("reads with one token exchange, writes with requiredRevisionId, maps a stale revision to a conflict, and every call has a timeout", async () => {
    const config = { docId: DOC, email: "care@project.iam.example", key: privateKey };
    const calls: { url: string; method: string; body: unknown; signal: boolean }[] = [];
    let batch = 0;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? (u === TOKEN_URL ? String(init.body) : JSON.parse(String(init.body))) : null, signal: init?.signal instanceof AbortSignal });
      if (u === TOKEN_URL) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      if (u.endsWith(":batchUpdate")) return ++batch === 1 ? new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION", message: "revision" } }), { status: 400 }) : new Response("{}");
      return new Response(JSON.stringify(makeDoc([...BEFORE, ...bullets([ln("Ann Roth", " (11/10/26)")]), ...AFTER], "rev-9")));
    }) as unknown as typeof fetch;
    const doc = createGooglePacket(config, { fetch: fake, now: () => new Date("2031-01-01T00:00:00Z") });
    const read = await doc.read();
    expect(read.revisionId).toBe("rev-9");
    expect(calls[0].body as string).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const edits = { remove: [], replace: [], insert: [{ before: 0, line: ln("Cal Dror", " (11/23/26)") }] };
    await expect(doc.write(read, edits)).rejects.toBeInstanceOf(PacketRevisionConflict);
    await doc.write(read, edits);
    const sent = calls.filter((c) => c.url.endsWith(":batchUpdate"));
    expect(sent).toHaveLength(2);
    expect((sent[0].body as { writeControl: unknown }).writeControl).toEqual({ requiredRevisionId: "rev-9" });
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
    expect(calls.every((c) => c.signal)).toBe(true);
    expect(await doc.describe()).toMatchObject({ bullets: 1 });
  });

  it("is 'not connected' without configuration and never calls out", async () => {
    const never = (() => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    await expect(createGooglePacket(null, { fetch: never }).read()).rejects.toMatchObject({ name: "PacketNotConnected" });
  });
});
