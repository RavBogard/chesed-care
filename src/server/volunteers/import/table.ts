/**
 * The common shape of most tabs: a header row (found by its content, not its position) and a person per row. Columns
 * are matched by the start of their label, so line breaks, "(314 unless noted otherwise)" and the like do not matter.
 * Pure.
 */
import type { CanDo } from "@/lib/can-do";
import { cell, emailsIn, headerKey, howOftenOf, offered, phonesIn, saysMore, sheetTimestamp, splitName, zipIn } from "./cells";
import { offerRule, type OfferRule } from "./offers";
import type { SheetPerson, TabResult } from "./types";

export const isBlank = (row: unknown[] | undefined): boolean => !row || row.every((c) => cell(c) === "");
const filled = (row: unknown[]) => row.filter((c) => cell(c) !== "").length;

/** A header row: it has a "first name" column and a "last name" column. */
export function isHeaderRow(row: unknown[] | undefined): boolean {
  if (!row) return false;
  const keys = row.map(headerKey);
  return keys.some((k) => k === "first" || k.startsWith("first name")) && keys.some((k) => k === "last" || k.startsWith("last name"));
}

/** A note or title: one cell filled in, and not a header. */
export const isNoteRow = (row: unknown[] | undefined): boolean => !!row && filled(row) === 1 && !isHeaderRow(row) && emailsIn(row.map(cell).join(" ")).length === 0;

export function emptyPerson(tab: string, row: number): SheetPerson {
  return { tab, row, firstName: "", lastName: null, markers: [], emails: [], phones: [], zip: null, address: null, city: null, canDo: [], offers: [], frequency: null, howOften: null, notes: [], history: [], okToText: null, coordinatorInterest: null, formAt: null, enteredAt: null, notVolunteered: false, fingerprint: "" };
}

type Role = "first" | "last" | "zip" | "address" | "city" | "phone" | "email" | "notes" | "history" | "frequency" | "entered" | "welcome" | "offer" | "other";

/** What each column holds, from its label. Order matters: the first rule that fits wins. */
function roleOf(key: string, offers: readonly OfferRule[] | null): Role {
  if (key === "") return "other";
  if (key.startsWith("first")) return "first";
  if (key.startsWith("last")) return "last";
  if (key.startsWith("zip")) return "zip";
  if (key.startsWith("address")) return "address";
  if (key.startsWith("city")) return "city";
  if (key.startsWith("phone") || key.startsWith("cell") || key.startsWith("home phone")) return "phone";
  if (key.startsWith("e mail") || key.startsWith("email")) return "email";
  if (key.startsWith("responded")) return "history";
  if (key.startsWith("notes") || key.startsWith("additional info")) return "notes";
  if (key.startsWith("times") || key.startsWith("how often")) return "frequency";
  if (key.startsWith("date info entered")) return "entered";
  if (key.startsWith("welcome email")) return "welcome";
  if (offers) return "offer";
  return "other";
}

export type TableOptions = {
  /** This tab's offer columns: every column the rules above do not claim is an offer. Null: no offer columns. */
  offers?: readonly OfferRule[] | null;
  /** What everyone on this tab can do (Drivers: rides). */
  canDo?: CanDo[];
  /** Where the "notes" column goes. Special situations: to the lead and clergy-only history. */
  notesTo?: "notes" | "history";
};

/** One data row read with a header row. Null when it has no name. */
export function readRow(tab: string, rowNumber: number, header: unknown[], row: unknown[], opts: TableOptions, unmapped: Set<string>): SheetPerson | null {
  const p = emptyPerson(tab, rowNumber);
  p.canDo = [...(opts.canDo ?? [])];
  header.forEach((h, i) => {
    const value = row[i];
    const text = cell(value);
    const key = headerKey(h);
    const role = roleOf(key, opts.offers ?? null);
    if (role === "offer") {
      const rule = offerRule(opts.offers!, cell(h));
      if (!rule) {
        if (offered(value)) {
          unmapped.add(cell(h));
          p.offers.push(saysMore(value) ? `${cell(h)}: ${text}` : cell(h));
        }
        return;
      }
      if (!offered(value)) return;
      if (rule.canDo) p.canDo.push(rule.canDo);
      if (!rule.canDo || rule.keep || saysMore(value)) p.offers.push(saysMore(value) ? `${rule.label}: ${text}` : rule.label);
      return;
    }
    if (text === "") return;
    switch (role) {
      case "first": {
        const n = splitName(value);
        p.firstName = n.name;
        p.markers.push(...n.markers);
        break;
      }
      case "last": {
        const n = splitName(value);
        p.lastName = n.name || null;
        p.markers.push(...n.markers);
        break;
      }
      case "zip":
        p.zip = zipIn(value) ?? text;
        break;
      case "address":
        p.address = text;
        p.zip ??= text.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? null;
        break;
      case "city":
        p.city = text;
        break;
      case "phone":
        p.phones.push(...phonesIn(value));
        break;
      case "email":
        p.emails.push(...emailsIn(value));
        break;
      case "history":
        p.history.push(text);
        break;
      case "notes":
        (opts.notesTo === "history" ? p.history : p.notes).push(text);
        break;
      case "frequency":
        p.frequency = text;
        p.howOften = howOftenOf(text);
        break;
      case "entered":
        p.enteredAt = sheetTimestamp(text);
        break;
      case "welcome":
        p.notes.push(`Welcome email sent: ${text}`);
        break;
      case "other":
        // A column this import does not know: kept as words, under its label, for the people who run the roster.
        if (key !== "") p.notes.push(`${cell(h)}: ${text}`);
        break;
    }
  });
  // Cells past the end of the header row: an email or a phone is kept, anything else as a note.
  for (const extra of row.slice(header.length)) {
    if (cell(extra) === "") continue;
    const es = emailsIn(extra);
    const ps = phonesIn(extra);
    if (es.length) p.emails.push(...es);
    else if (ps.length) p.phones.push(...ps);
    else p.notes.push(cell(extra));
  }
  p.markers = [...new Set(p.markers)];
  p.emails = [...new Set(p.emails)];
  p.phones = [...new Set(p.phones)];
  p.canDo = [...new Set(p.canDo)];
  if (!p.firstName && !p.lastName) return null;
  return p;
}

/**
 * A tab with one header row somewhere near the top. Rows above it are read too (a stray person typed above the
 * header), except a note: a row with one cell filled in. Blank rows are skipped.
 */
export function readTable(tab: string, rows: unknown[][], opts: TableOptions = {}): TabResult {
  const at = rows.findIndex(isHeaderRow);
  const unmapped = new Set<string>();
  if (at < 0) return { people: [], unparsed: rows.flatMap((r, i) => (isBlank(r) ? [] : [i + 1])), unmappedOffers: [] };
  const header = rows[at];
  const people: SheetPerson[] = [];
  const unparsed: number[] = [];
  rows.forEach((row, i) => {
    if (i === at || isBlank(row) || (i < at && isNoteRow(row))) return;
    const p = readRow(tab, i + 1, header, row, opts, unmapped);
    if (p) people.push(p);
    else unparsed.push(i + 1);
  });
  return { people, unparsed, unmappedOffers: [...unmapped] };
}
