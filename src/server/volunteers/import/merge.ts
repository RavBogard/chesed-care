/**
 * The same person across tabs and rows becomes one, and only on firm evidence: two rows are merged when they are the
 * same row (same fingerprint), or when they share an email or a phone number AND have the same, non-empty first name
 * (ignoring case, spaces and "*" marks). Nothing looser merges. A shared contact with another first name is usually a
 * couple's home phone or family email; a matching name with no shared contact may be two people. Both stay separate,
 * and a name-only match is listed by tab and row for a person to check. Pure.
 */
import type { CanDo } from "@/lib/can-do";
import { dateOf, nameKey, phoneKey } from "./cells";
import { TAB } from "./tabs";
import type { MergedPerson, SheetPerson } from "./types";

/** Which tab wins where two disagree (a name's spelling, the main email): the newest source first. */
const PRIORITY: string[] = [TAB.form, TAB.sheet, TAB.other, TAB.special, TAB.drivers, TAB.il].map((t) => t.toLowerCase());
const rank = (tab: string) => {
  const i = PRIORITY.indexOf(tab.toLowerCase());
  return i < 0 ? PRIORITY.length : i;
};

/** The same first name: equal after case, spaces, punctuation and "*" marks are set aside. An empty name matches nothing. */
export function sameFirstName(a: string | null, b: string | null): boolean {
  const x = nameKey(a);
  return x !== "" && x === nameKey(b);
}

export type Identity = { firstName: string | null; lastName: string | null; emails: string[]; phones: string[] };

const shares = (a: string[], b: string[]) => a.some((x) => b.includes(x));
const sharesContact = (a: Identity, b: Identity) => shares(a.emails, b.emails) || shares(a.phones.map(phoneKey), b.phones.map(phoneKey));
const fullName = (p: Identity) => (nameKey(p.firstName) && nameKey(p.lastName) ? `${nameKey(p.firstName)}|${nameKey(p.lastName)}` : null);

/**
 * How firmly two records are the same person. "exact": a shared contact and the same first name, the only match that
 * merges or links. "partial": a shared contact with another (or no) first name, or the same full name with no shared
 * contact; never merged, only reported. Null: not the same person.
 */
export function matchOf(a: Identity, b: Identity): "exact" | "partial" | null {
  const contact = sharesContact(a, b);
  if (contact && sameFirstName(a.firstName, b.firstName)) return "exact";
  if (contact) return "partial";
  const n = fullName(a);
  return n !== null && n === fullName(b) ? "partial" : null;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const firstOf = <T>(xs: (T | null)[]): T | null => xs.find((x) => x !== null && x !== "") ?? null;

function combine(group: SheetPerson[]): MergedPerson {
  const g = [...group].sort((a, b) => rank(a.tab) - rank(b.tab) || a.row - b.row);
  const forms = g.map((p) => p.formAt).filter((x): x is string => x !== null);
  const coord = g.map((p) => p.coordinatorInterest).filter((x) => x !== null);
  return {
    firstName: firstOf(g.map((p) => p.firstName)) ?? "",
    lastName: firstOf(g.map((p) => p.lastName)),
    markers: uniq(g.flatMap((p) => p.markers)),
    emails: uniq(g.flatMap((p) => p.emails)),
    phones: uniq(g.flatMap((p) => p.phones)),
    zip: firstOf(g.map((p) => p.zip)),
    address: firstOf(g.map((p) => p.address)),
    city: firstOf(g.map((p) => p.city)),
    canDo: uniq(g.flatMap((p) => p.canDo)) as CanDo[],
    offers: uniq(g.flatMap((p) => p.offers)),
    frequency: firstOf(g.map((p) => p.frequency)),
    howOften: firstOf(g.map((p) => p.howOften)),
    notes: uniq(g.flatMap((p) => p.notes)),
    history: uniq(g.flatMap((p) => p.history)),
    okToText: firstOf(g.map((p) => p.okToText)),
    coordinatorInterest: coord.length ? coord.includes(true) : null,
    formAt: forms.length ? forms.sort().at(-1)! : null,
    enteredAt: firstOf(g.map((p) => p.enteredAt)),
    // In the order the file gave the tabs.
    sources: uniq(group.map((p) => p.tab)),
    notVolunteered: group.every((p) => p.notVolunteered),
    fingerprints: uniq(group.map((p) => p.fingerprint).filter(Boolean)),
    rows: group.map((p) => ({ tab: p.tab, row: p.row })),
  };
}

export type Merged = { people: MergedPerson[]; /** Rows that may be the same person but were not merged (a name only), by tab and row. */ possibleDuplicates: { tab: string; row: number }[][] };

/** Group the rows of every tab into people. Order follows the first row of each person. */
export function mergePeople(rows: SheetPerson[]): Merged {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const named: [number, number][] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const same = rows[i].fingerprint !== "" && rows[i].fingerprint === rows[j].fingerprint;
      const m = same ? "exact" : matchOf(rows[i], rows[j]);
      if (m === "exact") {
        if (find(i) !== find(j)) parent[find(j)] = find(i);
      } else if (m === "partial" && !sharesContact(rows[i], rows[j])) named.push([i, j]);
    }
  }
  const groups = new Map<number, SheetPerson[]>();
  rows.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  const possibleDuplicates = named.filter(([i, j]) => find(i) !== find(j)).map(([i, j]) => [i, j].map((k) => ({ tab: rows[k].tab, row: rows[k].row })));
  return { people: [...groups.values()].map(combine), possibleDuplicates };
}

/** The day they first appear: the earliest form or "date info entered", or null. */
export function firstSeen(p: MergedPerson): string | null {
  const dates = [p.formAt, p.enteredAt].filter((x): x is string => x !== null).map(dateOf).sort();
  return dates[0] ?? null;
}
