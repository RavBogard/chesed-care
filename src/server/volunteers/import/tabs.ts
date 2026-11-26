/**
 * Each tab of the old Mitzvah Corps spreadsheet, read into people. Which reader a tab gets is decided by its name;
 * "Copy of Old Form…" tabs are ignored and any other tab is reported, not imported. Pure.
 */
import { cell, emailsIn, headerKey, howOftenOf, isPhoneCell, offered, phonesIn, saysMore, sheetTimestamp, splitName, yesNo, zipIn } from "./cells";
import { FORM_OFFERS, SHEET_OFFERS, offerRule } from "./offers";
import { emptyPerson, isBlank, isHeaderRow, isNoteRow, readRow, readTable } from "./table";
import type { SheetPerson, TabResult } from "./types";

export const TAB = {
  sheet: "MC Volunteers",
  form: "Volunteer Form Responses",
  drivers: "Drivers",
  special: "Special situations",
  il: "IL members",
  other: "Other volunteers",
} as const;
export type TabKind = keyof typeof TAB;

/** The reader for a tab, "ignore" for an old copy of the form, or null for a tab this import does not know. */
export function tabKind(name: string): TabKind | "ignore" | null {
  const key = headerKey(name);
  if (key.startsWith("copy of old form")) return "ignore";
  const found = (Object.keys(TAB) as TabKind[]).find((k) => headerKey(TAB[k]) === key);
  return found ?? null;
}

/** "Volunteer Form Responses": one header row; columns found by the start of their question. */
export function readFormTab(tab: string, rows: unknown[][]): TabResult {
  const at = rows.findIndex((r) => r.some((c) => headerKey(c).startsWith("timestamp")) || isHeaderRow(r));
  if (at < 0) return { people: [], unparsed: rows.flatMap((r, i) => (isBlank(r) ? [] : [i + 1])), unmappedOffers: [] };
  const header = rows[at].map(headerKey);
  const raw = rows[at].map(cell);
  const col = (...starts: string[]) => header.findIndex((h) => starts.some((s) => h.startsWith(s)));
  const c = {
    at: col("timestamp"),
    email: col("email address", "email", "e mail"),
    first: col("first name"),
    last: col("last name"),
    phone: col("best phone", "phone"),
    text: col("is it ok to text"),
    home: col("what is your home address"),
    work: col("what is your work address"),
    often: col("how often"),
    more: col("what else should"),
    coordinator: col("are you interested in serving as a coordinator"),
  };
  const offerCols = header.flatMap((h, i) => (h.startsWith("how can you help") ? [i] : []));
  const unmapped = new Set<string>();
  const people: SheetPerson[] = [];
  const unparsed: number[] = [];
  for (let i = at + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (isBlank(row)) continue;
    const get = (j: number) => (j >= 0 ? cell(row[j]) : "");
    const p = emptyPerson(tab, i + 1);
    const first = splitName(get(c.first));
    const last = splitName(get(c.last));
    p.firstName = first.name;
    p.lastName = last.name || null;
    p.markers = [...new Set([...first.markers, ...last.markers])];
    p.emails = emailsIn(get(c.email));
    p.phones = phonesIn(get(c.phone));
    p.okToText = yesNo(get(c.text));
    p.address = get(c.home) || null;
    p.zip = p.address ? ([...p.address.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].at(-1)?.[1] ?? null) : null;
    if (get(c.work)) p.notes.push(`Work address: ${get(c.work)}`);
    p.frequency = get(c.often) || null;
    p.howOften = howOftenOf(get(c.often));
    if (get(c.more)) p.notes.push(get(c.more));
    p.coordinatorInterest = yesNo(get(c.coordinator));
    p.formAt = sheetTimestamp(get(c.at));
    for (const j of offerCols) {
      if (!offered(row[j])) continue;
      const label = raw[j].match(/\[(.*)\]/)?.[1]?.trim() ?? raw[j];
      const rule = offerRule(FORM_OFFERS, label);
      if (!rule) {
        unmapped.add(label);
        p.offers.push(label);
        continue;
      }
      if (rule.canDo) p.canDo.push(rule.canDo);
      if (!rule.canDo || rule.keep || saysMore(row[j])) p.offers.push(saysMore(row[j]) ? `${rule.label}: ${cell(row[j])}` : rule.label);
    }
    p.canDo = [...new Set(p.canDo)];
    if (!p.firstName && !p.lastName) unparsed.push(i + 1);
    else people.push(p);
  }
  return { people, unparsed, unmappedOffers: [...unmapped] };
}

/**
 * "Drivers": a note in row 1, then rows with no header: Zip | First | Last | then any cells, where one with "@" is an
 * email and one that looks like a phone number is a phone. Everyone on it can drive.
 */
export function readDriversTab(tab: string, rows: unknown[][]): TabResult {
  const people: SheetPerson[] = [];
  const unparsed: number[] = [];
  rows.forEach((row, i) => {
    if (isBlank(row) || isNoteRow(row)) return;
    const cells = row.map(cell);
    // A header row someone added later is skipped.
    if (isHeaderRow(row) || ["first", "first name"].includes(headerKey(cells[1]))) return;
    const p = emptyPerson(tab, i + 1);
    p.canDo = ["rides"];
    p.zip = zipIn(cells[0]);
    const first = splitName(cells[1]);
    const last = splitName(cells[2]);
    p.firstName = first.name;
    p.lastName = last.name || null;
    p.markers = [...new Set([...first.markers, ...last.markers])];
    if (!p.zip && cells[0]) p.notes.push(cells[0]);
    for (const v of cells.slice(3)) {
      if (!v) continue;
      if (v.includes("@")) p.emails.push(...emailsIn(v));
      else if (isPhoneCell(v)) p.phones.push(...phonesIn(v));
      else p.notes.push(v);
    }
    p.emails = [...new Set(p.emails)];
    p.phones = [...new Set(p.phones)];
    if (!p.firstName && !p.lastName) unparsed.push(i + 1);
    else people.push(p);
  });
  return { people, unparsed, unmappedOffers: [] };
}

/**
 * "Special situations": blocks of a title row ("Dog walking for … Feb 2023"), a header row, and people. A title may name
 * a member, so it goes to the lead and clergy-only history of each person under it, and so do the block's notes.
 */
export function readSpecialTab(tab: string, rows: unknown[][]): TabResult {
  const people: SheetPerson[] = [];
  const unparsed: number[] = [];
  let header: unknown[] | null = null;
  let title: string | null = null;
  const unmapped = new Set<string>();
  rows.forEach((row, i) => {
    if (isBlank(row)) return;
    if (isHeaderRow(row)) {
      header = row;
      return;
    }
    if (isNoteRow(row)) {
      title = cell(row.find((c) => cell(c) !== ""));
      return;
    }
    if (!header) {
      unparsed.push(i + 1);
      return;
    }
    const p = readRow(tab, i + 1, header, row, { notesTo: "history" }, unmapped);
    if (!p) {
      unparsed.push(i + 1);
      return;
    }
    if (title) p.history.unshift(title);
    people.push(p);
  });
  return { people, unparsed, unmappedOffers: [] };
}

/** Read one tab by its kind. */
export function readTab(kind: TabKind, tab: string, rows: unknown[][]): TabResult {
  switch (kind) {
    case "sheet":
      return readTable(tab, rows, { offers: SHEET_OFFERS });
    case "form":
      return readFormTab(tab, rows);
    case "drivers":
      return readDriversTab(tab, rows);
    case "special":
      return readSpecialTab(tab, rows);
    case "il": {
      // "A * after a first name means they are a Mitzvah Corps volunteer"; everyone else here has not volunteered.
      const r = readTable(tab, rows);
      return { ...r, people: r.people.map((p) => ({ ...p, notVolunteered: p.markers.length === 0 })) };
    }
    case "other":
      return readTable(tab, rows);
  }
}
