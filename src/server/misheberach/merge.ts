/**
 * The three-way merge of the packet's Healing Prayers section with the app's list. Pure.
 *
 * The three sides: the SNAPSHOT (the section as it stood after the last successful sync, with each
 * line's bold runs), the DOC (the section now) and the APP (the entries now). The guiding rule: the
 * app never rewrites a doc line it has no reason to change. A line is written only when an app-side
 * FIELD of its entry changed since the snapshot; a line the app cannot read, a duplicate of a name
 * already on the list, and a line for someone who asked not to be listed are left exactly where they
 * are and counted. A REMOVAL on either side beats an untouched copy on the other, so a removed name
 * cannot come back. Existing lines are never re-sorted; a new line goes in at its sorted place.
 * Names and lines are data here and are never logged.
 */
import { addDaysIso, DATED_DAYS, formatLine, nameKey, parseLine, sameFields, type LineFields, type PacketLine, type ParsedLine } from "./line";

export type EntryState = LineFields & {
  id: string;
  nameKey: string;
  consent: "confirmed" | "not_confirmed" | "asked_not_listed";
  docLine: string | null;
  ended: boolean;
  /** When the entry last changed (ms): a change made after the plan was computed makes the sync skip it. */
  updatedAt?: number;
};
export type SnapshotItem = { line: string; bold?: readonly (readonly [number, number])[]; entryId: string };

export type NewEntry = {
  name: string;
  nameKey: string;
  dateAdded: string;
  kind: "dated" | "standing";
  askedBy: string | null;
  specialRequest: boolean;
  consent: "confirmed" | "not_confirmed";
  needsReview: boolean;
  docLine: string;
  keepUntil: string | null;
};
export type EntryPatch = { name?: string; nameKey?: string; dateAdded?: string; kind?: "dated" | "standing"; askedBy?: string | null; specialRequest?: boolean; needsReview?: true; docLine?: string; keepUntil?: string | null };
export type Ref = { id: string } | { create: number };
/** A line the packet will hold after the run, for the next snapshot. `viaWrite`: it is there only because this run wrote it. */
export type SnapshotLine = { ref: Ref; text: string; bold: PacketLine["bold"]; viaWrite: boolean };

/** The packet changes, by position in the lines that were read. `before === lines.length` means after the last line. */
export type SectionEdits = { remove: number[]; replace: { index: number; line: PacketLine }[]; insert: { before: number; line: PacketLine }[] };

/** What the sync would do, in words clergy can read (dry run, or a run that was stopped). Capped; names are in it. */
export type Plan = {
  addLines: string[];
  changeLines: { from: string; to: string }[];
  removeLines: string[];
  addEntries: string[];
  endEntries: string[];
  leftAlone: { text: string; why: "unreadable" | "duplicate" | "asked_not_listed" | "ended_in_app" }[];
  /** A stopped run only: a stable hash of the planned edits and entry changes, so "Apply anyway" can tell it is the same plan. */
  hash?: string;
};

export type MergeCounts = {
  addedFromPacket: number;
  removedInPacket: number;
  editedInPacket: number;
  writtenToPacket: number;
  removedFromPacket: number;
  blocked: number;
  duplicates: number;
  leftAlone: number;
  needsReview: number;
  removedBarred: number;
};

export type MergeResult = {
  create: NewEntry[];
  update: { id: string; patch: EntryPatch; expect?: number }[];
  end: { id: string; expect?: number }[];
  relink: { id: string; docLine: string; expect?: number }[];
  snapshot: SnapshotLine[];
  edits: SectionEdits;
  write: boolean;
  counts: MergeCounts;
  plan: Plan;
};

const PLAN_CAP = 60;
const emptyCounts = (): MergeCounts => ({ addedFromPacket: 0, removedInPacket: 0, editedInPacket: 0, writtenToPacket: 0, removedFromPacket: 0, blocked: 0, duplicates: 0, leftAlone: 0, needsReview: 0, removedBarred: 0 });
const emptyPlan = (): Plan => ({ addLines: [], changeLines: [], removeLines: [], addEntries: [], endEntries: [], leftAlone: [] });
const cap = <T,>(list: T[], v: T) => {
  if (list.length < PLAN_CAP) list.push(v);
};

type DocItem = { idx: number; line: PacketLine; parsed: ParsedLine | null; used: boolean };

const fieldsOf = (p: ParsedLine, today: string, fallback?: LineFields): LineFields => ({
  name: p.name,
  dateAdded: p.date ?? fallback?.dateAdded ?? today,
  kind: p.standing ? "standing" : "dated",
  askedBy: p.askedBy,
  specialRequest: p.special,
});

/** A dated name imported with its 120 days already up, or up within a week, may not come off for a week: the prompt comes first. */
export function graceFor(kind: "dated" | "standing", dateAdded: string, today: string): string | null {
  if (kind !== "dated") return null;
  return addDaysIso(dateAdded, DATED_DAYS) <= addDaysIso(today, 7) ? addDaysIso(today, 7) : null;
}

/** Whether a packet line, first linked to an entry the app already had, says something different from that entry. */
function firstLinkDiffers(parsed: { date: string | null; askedBy?: string | null }, fields: LineFields, entry: EntryState): boolean {
  return (
    (parsed.date !== null && parsed.date !== entry.dateAdded) ||
    (parsed.askedBy ?? null) !== (entry.askedBy?.trim() || null) ||
    fields.kind !== entry.kind ||
    fields.specialRequest !== entry.specialRequest
  );
}

export function mergeSection(input: {
  snapshot: SnapshotItem[] | null;
  doc: PacketLine[];
  entries: EntryState[];
  firstRun: boolean;
  today: string;
  /** Clergy asked: take the lines of people who asked not to be listed out of the packet (this is the one thing that removes a line the app has no entry for). */
  removeBarred?: boolean;
}): MergeResult {
  const { today } = input;
  const items: DocItem[] = input.doc.map((line, idx) => ({ idx, line, parsed: parseLine(line), used: false }));
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const counts = emptyCounts();
  const plan = emptyPlan();
  const result = { create: [] as NewEntry[], update: [] as MergeResult["update"], end: [] as MergeResult["end"], relink: [] as MergeResult["relink"] };
  const edits: SectionEdits = { remove: [], replace: [], insert: [] };
  const claimedKeys = new Set<string>();
  const pairedKeys = new Set<string>();
  // What the packet holds after the run, for the snapshot: by doc position for lines that stay, and the new lines to place.
  const atIdx = new Map<number, SnapshotLine>();
  const fresh: { line: PacketLine; ref: Ref; kind: "dated" | "standing"; date: string }[] = [];
  const handled = new Set<string>();
  const dropped = new Set<number>();

  const pairs: { snap: SnapshotItem; entry: EntryState; item: DocItem | null }[] = [];
  const snapshot = (input.snapshot ?? []).filter((s) => byId.has(s.entryId));
  // Match each snapshot line to the packet: the same text first, then the same name.
  for (const snap of snapshot) {
    const item = items.find((i) => !i.used && i.line.text === snap.line);
    if (item) item.used = true;
    pairs.push({ snap, entry: byId.get(snap.entryId)!, item: item ?? null });
  }
  for (const pair of pairs) {
    if (pair.item) continue;
    const snapKey = parseLine({ text: pair.snap.line, bold: pair.snap.bold ?? [] })?.nameKey;
    const item = items.find((i) => !i.used && i.parsed && (i.parsed.nameKey === pair.entry.nameKey || i.parsed.nameKey === snapKey));
    if (item) {
      item.used = true;
      pair.item = item;
    }
  }

  const stays = (entry: EntryState, item: DocItem, fields: LineFields, text: string, bold: PacketLine["bold"], viaWrite: boolean) => {
    claimedKeys.add(nameKey(fields.name));
    atIdx.set(item.idx, { ref: { id: entry.id }, text, bold, viaWrite });
    if (entry.docLine !== text) result.relink.push({ id: entry.id, docLine: text, expect: entry.updatedAt });
  };
  const leaveAlone = (item: DocItem, why: Plan["leftAlone"][number]["why"]) => {
    cap(plan.leftAlone, { text: item.line.text, why });
    if (why === "unreadable") counts.leftAlone++;
    if (why === "duplicate") counts.duplicates++;
    if (why === "asked_not_listed") counts.blocked++;
  };

  const barred = new Set(input.entries.filter((e) => e.consent === "asked_not_listed").map((e) => e.nameKey));

  for (const { snap, entry, item } of pairs) {
    handled.add(entry.id);
    pairedKeys.add(entry.nameKey);
    if (!item) {
      // Removed in the packet: the entry comes off, whatever the app side did since.
      if (!entry.ended) {
        result.end.push({ id: entry.id, expect: entry.updatedAt });
        counts.removedInPacket++;
        cap(plan.endEntries, entry.name);
      }
      continue;
    }
    if (entry.ended) {
      // Removed in the app: the packet's copy goes, edited or not.
      edits.remove.push(item.idx);
      dropped.add(item.idx);
      counts.removedFromPacket++;
      cap(plan.removeLines, item.line.text);
      continue;
    }
    // "Was" and "now" are read the same way: the snapshot keeps each line's bold runs.
    const was = parseLine({ text: snap.line, bold: snap.bold ?? [] });
    const appChanged = !was || !sameFields(was, entry);
    const docChanged = item.line.text !== snap.line;
    const parsed = item.parsed;
    if (!parsed) {
      // Present but unreadable now: carried as it is, entry untouched.
      atIdx.set(item.idx, { ref: { id: entry.id }, text: snap.line, bold: snap.bold ?? [], viaWrite: false });
      claimedKeys.add(entry.nameKey);
      leaveAlone(item, "unreadable");
      continue;
    }
    if (!docChanged && !appChanged) {
      // Even a change in which text is bold changes nothing: the line is neither rewritten nor re-read differently next time.
      stays(entry, item, entry, item.line.text, snap.bold ?? item.line.bold, false);
    } else if (!docChanged) {
      // An app-side field changed: this one paragraph's text is replaced, and nothing else is touched.
      const line = formatLine(entry);
      edits.replace.push({ index: item.idx, line });
      counts.writtenToPacket++;
      cap(plan.changeLines, { from: item.line.text, to: line.text });
      stays(entry, item, entry, line.text, line.bold, true);
    } else {
      // Edited in the packet (and, if the app side changed too, the packet's words stand and a person is asked to look).
      const fields = fieldsOf(parsed, today, entry);
      const renamed = parsed.nameKey !== entry.nameKey;
      if (renamed && barred.has(parsed.nameKey)) {
        // Renamed to someone who asked not to be listed: the line stays as typed, the entry is not touched, a person is asked to look.
        result.update.push({ id: entry.id, patch: { needsReview: true }, expect: entry.updatedAt });
        counts.needsReview++;
        atIdx.set(item.idx, { ref: { id: entry.id }, text: snap.line, bold: snap.bold ?? [], viaWrite: false });
        claimedKeys.add(entry.nameKey);
        leaveAlone(item, "asked_not_listed");
        continue;
      }
      const review = appChanged || renamed;
      result.update.push({ id: entry.id, patch: { ...fields, nameKey: parsed.nameKey, ...(review ? { needsReview: true as const } : {}), docLine: item.line.text }, expect: entry.updatedAt });
      counts.editedInPacket++;
      if (review) counts.needsReview++;
      stays({ ...entry, docLine: item.line.text }, item, fields, item.line.text, item.line.bold, false);
    }
  }

  // Lines in the packet that no snapshot line accounts for: added there.
  const live = new Map(input.entries.filter((e) => !e.ended).map((e) => [e.nameKey, e]));
  for (const item of items) {
    if (item.used) continue;
    const parsed = item.parsed;
    if (!parsed) {
      leaveAlone(item, "unreadable");
      continue;
    }
    const key = parsed.nameKey;
    const entry = live.get(key);
    if (entry && !claimedKeys.has(key) && !pairedKeys.has(key)) {
      // A name already on the list that the packet has too (typed in both, or an override of someone who asked not to be listed): the packet's words stand. Its date and who asked go into the entry, flagged if they differed; the line is not rewritten.
      const fields = fieldsOf(parsed, today, entry);
      const differs = firstLinkDiffers(parsed, fields, entry);
      result.update.push({ id: entry.id, patch: { ...fields, nameKey: key, docLine: item.line.text, keepUntil: graceFor(fields.kind, fields.dateAdded, today), ...(differs ? { needsReview: true as const } : {}) }, expect: entry.updatedAt });
      if (differs) counts.needsReview++;
      stays({ ...entry, docLine: item.line.text }, item, fields, item.line.text, item.line.bold, false);
    } else if (claimedKeys.has(key) || pairedKeys.has(key)) {
      // The same name twice: two people can share a name, but the list holds one live entry per name, so the second line is left exactly as it is and flagged.
      leaveAlone(item, "duplicate");
    } else if (barred.has(key)) {
      if (input.removeBarred) {
        edits.remove.push(item.idx);
        dropped.add(item.idx);
        counts.removedBarred++;
        cap(plan.removeLines, item.line.text);
      } else {
        // Someone asked not to be listed: the line stays as it is, no entry is made, and clergy are told.
        leaveAlone(item, "asked_not_listed");
      }
    } else {
      const fields = fieldsOf(parsed, today);
      const review = parsed.date === null && !parsed.standing;
      result.create.push({ ...fields, nameKey: key, consent: input.firstRun ? "confirmed" : "not_confirmed", needsReview: review, docLine: item.line.text, keepUntil: graceFor(fields.kind, fields.dateAdded, today) });
      claimedKeys.add(key);
      counts.addedFromPacket++;
      cap(plan.addEntries, fields.name);
      if (review) counts.needsReview++;
      atIdx.set(item.idx, { ref: { create: result.create.length - 1 }, text: item.line.text, bold: item.line.bold, viaWrite: false });
    }
  }

  // A line that matches nothing, in a run that also lost a line, may be a name that was retyped: remove plus add, flagged for a person to look at.
  if (result.end.length > 0) {
    for (const n of result.create) {
      if (!n.needsReview) counts.needsReview++;
      n.needsReview = true;
    }
  }

  // Entries the packet has never had: a new line each, at its sorted place.
  for (const entry of input.entries) {
    if (entry.ended || handled.has(entry.id) || claimedKeys.has(entry.nameKey)) continue;
    const line = formatLine(entry);
    claimedKeys.add(entry.nameKey);
    fresh.push({ line, ref: { id: entry.id }, kind: entry.kind, date: entry.dateAdded });
    result.relink.push({ id: entry.id, docLine: line.text, expect: entry.updatedAt });
    counts.writtenToPacket++;
    cap(plan.addLines, line.text);
  }

  // Where each new line goes: newest first among the dated ones, before the first standing line; a standing one last. Existing lines keep their order.
  const survivors = items.filter((i) => !dropped.has(i.idx));
  const dateOf = (i: DocItem): { standing: boolean; date: string | null } | null => {
    const replaced = edits.replace.find((r) => r.index === i.idx);
    const p = replaced ? parseLine(replaced.line) : i.parsed;
    return p ? { standing: p.standing, date: p.date } : null;
  };
  const ordered = [...fresh].sort((a, b) => (a.kind === b.kind ? (a.date === b.date ? 0 : a.date < b.date ? 1 : -1) : a.kind === "dated" ? -1 : 1));
  for (const f of ordered) {
    let before = input.doc.length;
    if (f.kind === "dated") {
      const spot = survivors.find((i) => {
        const d = dateOf(i);
        return d !== null && (d.standing || (d.date !== null && d.date <= f.date));
      });
      if (spot) before = spot.idx;
    }
    edits.insert.push({ before, line: f.line });
  }

  // The snapshot of what the packet holds after the run, in order.
  const snapshotLines: SnapshotLine[] = [];
  const insertsAt = (i: number) => edits.insert.filter((x) => x.before === i);
  const freshRef = new Map(fresh.map((f) => [f.line, f.ref]));
  const pushInserts = (i: number) => {
    for (const ins of insertsAt(i)) snapshotLines.push({ ref: freshRef.get(ins.line)!, text: ins.line.text, bold: ins.line.bold, viaWrite: true });
  };
  for (let i = 0; i < input.doc.length; i++) {
    pushInserts(i);
    const kept = atIdx.get(i);
    if (kept) snapshotLines.push(kept);
  }
  pushInserts(input.doc.length);

  return { ...result, snapshot: snapshotLines, edits, write: edits.remove.length + edits.replace.length + edits.insert.length > 0, counts, plan };
}

/** The result of a read-only reconciliation (a snapshot that was lost): nothing is written to the packet and nothing is ended. */
export type Reconciled = {
  create: NewEntry[];
  update: { id: string; patch: EntryPatch; expect?: number }[];
  relink: { id: string; docLine: string; expect?: number }[];
  snapshot: SnapshotLine[];
  counts: { matched: number; created: number; stillInPacket: number; notInPacket: number; leftAlone: number; duplicates: number; blocked: number; needsReview: number };
  plan: Plan;
};

/**
 * A lost snapshot with entries already on the list: match each readable line to a live entry by name
 * (the packet's date and who-asked go into the entry, flagged if they differed), pair a line with an
 * ENDED entry only when it is exactly that entry's last-seen line, and make an entry for any other
 * name nobody has (unless the person asked not to be listed). Writes nothing to the packet and ends
 * nothing. A name ended in the app but still in the packet is counted ("still in the packet") and
 * paired with its ended entry, so the next ordinary run applies removal-wins under the sanity brake.
 */
export function reconcileSection(input: { doc: PacketLine[]; entries: EntryState[]; today: string }): Reconciled {
  const plan = emptyPlan();
  const counts = { matched: 0, created: 0, stillInPacket: 0, notInPacket: 0, leftAlone: 0, duplicates: 0, blocked: 0, needsReview: 0 };
  const create: NewEntry[] = [];
  const update: Reconciled["update"] = [];
  const snapshot: SnapshotLine[] = [];
  const liveByKey = new Map(input.entries.filter((e) => !e.ended).map((e) => [e.nameKey, e]));
  const endedByLine = new Map(input.entries.filter((e) => e.ended && e.docLine).map((e) => [e.docLine!, e]));
  const barred = new Set(input.entries.filter((e) => e.consent === "asked_not_listed").map((e) => e.nameKey));
  const seen = new Set<string>();
  const paired = new Set<string>();
  for (const line of input.doc) {
    const parsed = parseLine(line);
    if (!parsed) {
      counts.leftAlone++;
      cap(plan.leftAlone, { text: line.text, why: "unreadable" });
      continue;
    }
    const key = parsed.nameKey;
    const ended = endedByLine.get(line.text);
    if (ended && !paired.has(ended.id)) {
      paired.add(ended.id);
      seen.add(key);
      counts.stillInPacket++;
      cap(plan.leftAlone, { text: line.text, why: "ended_in_app" });
      snapshot.push({ ref: { id: ended.id }, text: line.text, bold: line.bold, viaWrite: false });
      continue;
    }
    if (seen.has(key)) {
      counts.duplicates++;
      cap(plan.leftAlone, { text: line.text, why: "duplicate" });
      continue;
    }
    const entry = liveByKey.get(key);
    if (entry) {
      seen.add(key);
      paired.add(entry.id);
      const fields = fieldsOf(parsed, input.today, entry);
      const differs = firstLinkDiffers(parsed, fields, entry);
      update.push({ id: entry.id, patch: { ...fields, nameKey: key, docLine: line.text, keepUntil: graceFor(fields.kind, fields.dateAdded, input.today), ...(differs ? { needsReview: true as const } : {}) }, expect: entry.updatedAt });
      if (differs) counts.needsReview++;
      counts.matched++;
      snapshot.push({ ref: { id: entry.id }, text: line.text, bold: line.bold, viaWrite: false });
    } else if (barred.has(key)) {
      counts.blocked++;
      cap(plan.leftAlone, { text: line.text, why: "asked_not_listed" });
    } else {
      seen.add(key);
      const fields = fieldsOf(parsed, input.today);
      create.push({ ...fields, nameKey: key, consent: "not_confirmed", needsReview: parsed.date === null && !parsed.standing, docLine: line.text, keepUntil: graceFor(fields.kind, fields.dateAdded, input.today) });
      counts.created++;
      cap(plan.addEntries, fields.name);
      snapshot.push({ ref: { create: create.length - 1 }, text: line.text, bold: line.bold, viaWrite: false });
    }
  }
  // Live entries the packet did not have: those that were once in it (they have a last-seen line) stay paired with that line, so the next run treats the absence as a removal; the others are new to the packet and are written then.
  for (const e of input.entries) {
    if (e.ended || paired.has(e.id)) continue;
    if (e.docLine) {
      counts.notInPacket++;
      snapshot.push({ ref: { id: e.id }, text: e.docLine, bold: [], viaWrite: false });
    }
  }
  return { create, update, relink: [], snapshot, counts, plan };
}
