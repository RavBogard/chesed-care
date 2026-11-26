/**
 * Reading single cells of the old Mitzvah Corps spreadsheet: names with "*" marks, emails, phone numbers written every
 * which way, dates and "how often". Pure; nothing here touches a database or logs anything.
 */
import { HOW_OFTEN, type HowOften } from "@/lib/can-do";

// Control, zero-width and bidirectional characters: refused by the app's own inputs (src/server/meals/input.ts), so stripped here.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085​-‏‪-‮⁠-⁩﻿]/g;

/** A cell as one trimmed line: unsafe characters removed, line breaks and runs of spaces one space. Anything that is not text is empty. */
export const cell = (v: unknown): string =>
  (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")
    .replace(UNSAFE, "")
    .replace(/\s+/g, " ")
    .trim();

/** The app's field limits (src/server/volunteers/roster-input.ts), and the cap on each kept line of notes or history. */
export const LIMITS = { firstName: 60, lastName: 60, email: 254, mobile: 40, area: 60, line: 1000 } as const;

/** A value cut to `max` characters; when cut, the whole value is handed to `overflow` so nothing is dropped. */
export function fit(value: string | null, max: number, overflow: (whole: string) => void): string | null {
  if (value === null || value.length <= max) return value;
  overflow(value.slice(0, LIMITS.line));
  return value.slice(0, max).trim();
}

/** A header label for matching: lower case, line breaks and punctuation runs become single spaces. */
export const headerKey = (v: unknown): string =>
  cell(v)
    .toLowerCase()
    .replace(/[^a-z0-9@#/]+/g, " ")
    .trim();

/** A name and the marks the sheet put on it ("Rina*" is "Rina" with the mark "*"). */
export function splitName(raw: unknown): { name: string; markers: string[] } {
  const v = cell(raw);
  const marks = v.match(/[*†+]+/g) ?? [];
  const name = v
    .replace(/[*†+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { name, markers: [...new Set(marks)] };
}

/** How the same name is compared across tabs: lower case letters only. */
export const nameKey = (v: string | null | undefined): string => (v ?? "").toLowerCase().replace(/[^a-z]/g, "");

const EMAIL = /[^\s@,;:<>()[\]"']+@[^\s@,;:<>()[\]"']+\.[a-z]{2,}/gi;

/** Every valid email address in a cell, lower-cased. */
export function emailsIn(raw: unknown): string[] {
  const found = cell(raw).match(EMAIL) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/\.+$/, "")).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
}

// A US number: an optional area code (with or without brackets), then 3 and 4 digits, separated by spaces, dots or dashes.
const PHONE = /(?:\+?1[\s.-]*)?(?:\(?(\d{3})\)?[\s.-]*)?(\d{3})[\s.-]*(\d{4})(?!\d)/g;

/** The default area code: "phone #1 (314 unless noted otherwise)". */
export const DEFAULT_AREA = "314";

/** Every phone number in a cell, as "314-555-1234". A seven-digit number is in area code 314. */
export function phonesIn(raw: unknown): string[] {
  const v = cell(raw);
  if (v.includes("@")) return [];
  const out: string[] = [];
  for (const m of v.matchAll(PHONE)) {
    const before = v.slice(0, m.index);
    // Digits straight before the match mean it is the tail of a longer number, not a phone of its own.
    if (/\d$/.test(before)) continue;
    out.push(`${m[1] ?? DEFAULT_AREA}-${m[2]}-${m[3]}`);
  }
  return [...new Set(out)];
}

/** The digits that recognise a phone number: the same as the roster's mobile key (src/server/volunteers/input.ts). */
export const phoneKey = (phone: string): string => phone.replace(/\D/g, "");

/** Whether a cell looks like a phone number and nothing much else. */
export const isPhoneCell = (raw: unknown): boolean => phonesIn(raw).length > 0 && cell(raw).replace(/[\d\s().+-]/g, "").length <= 12;

/** A US ZIP code at the start of a cell, or null. */
export function zipIn(raw: unknown): string | null {
  const m = cell(raw).match(/^(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

/** Whether a cell says "yes, I offer this": "X", "Yes", or words of its own. Blank, "no", "n", "-" and "0" do not. */
export function offered(raw: unknown): boolean {
  const v = cell(raw).toLowerCase();
  return v !== "" && !["no", "n", "-", "0", "false", "none", "n/a"].includes(v);
}

/** Whether an offer cell said more than a plain mark ("video" rather than "X" or "Yes"). */
export const saysMore = (raw: unknown): boolean => offered(raw) && !["x", "yes", "y", "true", "✓", "√"].includes(cell(raw).toLowerCase());

/** Yes, no, or not said. */
export function yesNo(raw: unknown): boolean | null {
  const v = cell(raw).toLowerCase();
  if (v === "") return null;
  if (/^(yes|y|x|ok|sure)\b/.test(v)) return true;
  if (/^(no|n)\b/.test(v)) return false;
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A date the sheet wrote ("3/22/2024 14:05:01", "2024-03-22", "3/22/24"), as an ISO date-time in UTC, or null. */
export function sheetTimestamp(raw: unknown): string | null {
  const v = cell(raw);
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const [mo, d] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${year}-${pad(mo)}-${pad(d)}T${pad(Number(m[4] ?? 12))}:${m[5] ?? "00"}:${m[6] ?? "00"}.000Z`;
  }
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z` : null;
}

/** The date part of an ISO date-time. */
export const dateOf = (iso: string): string => iso.slice(0, 10);

/**
 * "How often" in the sheet's words, as the roster's choice when the words are plain enough: a number of times a year,
 * or "monthly", "as needed" and the like. Anything else is kept only as words.
 */
export function howOftenOf(raw: unknown): HowOften | null {
  const v = cell(raw).toLowerCase();
  if (v === "") return null;
  if (/as needed|whenever|any ?time|as often|when needed|on call/.test(v)) return "as_needed";
  if (/month/.test(v)) return "monthly";
  if (/quarter|every (three|3) months/.test(v)) return "quarterly";
  if (/twice a year|two times a year|2 times a year|semi/.test(v)) return "twice_a_year";
  if (/once a year|one time a year|1 time a year|annual|yearly/.test(v)) return "once_a_year";
  const nums = (v.match(/\d+/g) ?? []).map(Number);
  if (nums.length === 0) return null;
  // A number is times a year. "2-3" counts as the larger, and each count maps to the choice that asks no more often than that.
  const n = Math.max(...nums);
  if (n === 0) return null;
  const choice: HowOften = n <= 1 ? "once_a_year" : n <= 3 ? "twice_a_year" : n <= 11 ? "quarterly" : "monthly";
  return (HOW_OFTEN as readonly string[]).includes(choice) ? choice : null;
}
