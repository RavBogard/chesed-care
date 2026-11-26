/**
 * Occasions as cards for the screens. A yahrzeit or a shloshim is one card for each
 * mourner (each observer row), so the person to contact leads; the mourners of one
 * death stay next to one another. A birthday or an anniversary is one card each.
 * PURE: no I/O.
 */
import type { Occasion, OccasionType } from "./types";

export type OccasionCard = {
  key: string;
  type: OccasionType;
  date: string;
  /** Whom the occasion is about; null when Salesforce holds no usable name. */
  name: string | null;
  hebrewName: string | null;
  /** The Hebrew date of death on a memorial card. */
  hebrewDeathDate: string | null;
  years: number | null;
  deathDate: string | null;
  /** The rows to act on. A memorial card holds exactly one: its mourner, or the row with nobody to contact. */
  people: Occasion[];
};

const MEMORIAL: ReadonlySet<OccasionType> = new Set(["yahrzeit", "shloshim"]);

export function isMemorial(type: OccasionType): boolean {
  return MEMORIAL.has(type);
}

const OWN_NAMES = new Set(["central reform congregation", "crc", "deceased"]);

/**
 * A name or household safe to show. Placeholders ("(unnamed)"), the catch-all
 * DECEASED account and the congregation's own account are records, not people.
 */
export function cleanLabel(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (v.startsWith("(") && v.endsWith(")")) return null;
  if (OWN_NAMES.has(v.toLowerCase())) return null;
  return v;
}

/**
 * Rows as cards. A memorial row is always a card of its own, placed straight after the
 * last card for the same death, so several mourners of one person stay adjacent and in
 * the order they came in. Other rows are grouped as before, in order of first appearance.
 */
export function toCards(items: readonly Occasion[]): OccasionCard[] {
  const cards = new Map<string, OccasionCard>();
  /** The cards of each death, in order; one entry per group for a celebration. */
  const groups = new Map<string, OccasionCard[]>();
  for (const o of items) {
    const memorial = isMemorial(o.type);
    const group = memorial ? `${o.type}|${o.subjectId}|${o.date}` : `${o.type}|${o.subjectId}|${o.accountId ?? ""}|${o.date}`;
    const base = memorial ? `${group}|${o.accountId ?? ""}|${o.contactId ?? ""}` : group;
    let key = base;
    if (memorial) for (let n = 2; cards.has(key); n++) key = `${base}|${n}`;
    const card = cards.get(key);
    if (card) {
      card.people.push(o);
      continue;
    }
    const made: OccasionCard = { key, type: o.type, date: o.date, name: cleanLabel(o.personName), hebrewName: o.hebrewName, hebrewDeathDate: o.hebrewDeathDate, years: o.years, deathDate: o.deathDate, people: [o] };
    cards.set(key, made);
    groups.set(group, [...(groups.get(group) ?? []), made]);
  }
  return [...groups.values()].flat();
}

/** The four kinds in the order they are always shown: the memorials first, then the celebrations. */
const KINDS: { type: OccasionType; one: string; many: string }[] = [
  { type: "yahrzeit", one: "yahrzeit", many: "yahrzeits" },
  { type: "shloshim", one: "shloshim", many: "shloshim" },
  { type: "birthday", one: "birthday", many: "birthdays" },
  { type: "anniversary", one: "anniversary", many: "anniversaries" },
];

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The word for a kind as a label: "Yahrzeit", "Shloshim", "Birthday", "Anniversary". */
export function kindWord(type: OccasionType): string {
  return capital(KINDS.find((k) => k.type === type)?.one ?? type);
}

/** Cards in the fixed order of kinds; within a kind, the order they came in. */
export function sortByKind(cards: readonly OccasionCard[]): OccasionCard[] {
  return KINDS.flatMap((k) => cards.filter((c) => c.type === k.type));
}

/** Cards gathered under their kind, in the fixed order; a kind with no cards is left out. The heading names the kind for its count: "Yahrzeits" for three, "Yahrzeit" for one. */
export function byKind(cards: readonly OccasionCard[]): { type: OccasionType; heading: string; cards: OccasionCard[] }[] {
  return KINDS.flatMap((k) => {
    const own = cards.filter((c) => c.type === k.type);
    return own.length ? [{ type: k.type, heading: capital(own.length === 1 ? k.one : k.many), cards: own }] : [];
  });
}

/** How many cards of each kind (a yahrzeit with three mourners is three: one to contact each), in a fixed order. */
export function kindCounts(items: readonly Occasion[]): { type: OccasionType; count: number; label: string }[] {
  const cards = toCards(items);
  return KINDS.map((k) => {
    const count = cards.filter((c) => c.type === k.type).length;
    return { type: k.type, count, label: `${count} ${count === 1 ? k.one : k.many}` };
  }).filter((k) => k.count > 0);
}

/** Rows grouped by date, in date order. */
export function byDay(items: readonly Occasion[]): { date: string; occasions: Occasion[] }[] {
  const days = new Map<string, Occasion[]>();
  for (const o of items) days.set(o.date, [...(days.get(o.date) ?? []), o]);
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, occasions]) => ({ date, occasions }));
}

/** The id of a day's group on /upcoming, so Today can link straight to it. */
export function dayAnchor(date: string): string {
  return `day-${date}`;
}
