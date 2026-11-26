/**
 * A civil date as the Hebrew date in Hebrew letters: "2026-11-23" → "י״ג כסלו תשפ״ז".
 * The calendar conversion is Intl's (the Hebrew calendar); the lettering is ours, because
 * Intl writes the day and year as digits. The civil day is taken as a whole: the Hebrew date
 * shown is the one that holds from the morning, not the one that begins at sunset.
 */

const GERESH = "׳";
const GERSHAYIM = "״";

const ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const HUNDREDS = ["", "ק", "ר", "ש", "ת"];

/** 1–999 in Hebrew letters with its geresh or gershayim: 13 → י״ג, 15 → ט״ו, 16 → ט״ז, 1 → א׳, 787 → תשפ״ז. */
export function gematria(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) return String(n);
  let letters = "";
  let rest = n;
  while (rest >= 400) {
    letters += HUNDREDS[4];
    rest -= 400;
  }
  letters += HUNDREDS[Math.floor(rest / 100)];
  rest %= 100;
  // 15 and 16 are written 9+6 and 9+7, never with the letters of the divine name.
  if (rest === 15) letters += "טו";
  else if (rest === 16) letters += "טז";
  else letters += TENS[Math.floor(rest / 10)] + ONES[rest % 10];
  return letters.length === 1 ? `${letters}${GERESH}` : `${letters.slice(0, -1)}${GERSHAYIM}${letters.slice(-1)}`;
}

const ADAR_I = `אדר א${GERESH}`;
const ADAR_II = `אדר ב${GERESH}`;

/**
 * English month names to the Hebrew we print: Intl's own (and the spellings other ICU
 * versions use), and the spellings people type into Salesforce. Keys are lower-case with
 * single spaces; see monthKey.
 */
const MONTHS: Record<string, string> = {
  tishri: "תשרי",
  tishrei: "תשרי",
  heshvan: "חשון",
  cheshvan: "חשון",
  marheshvan: "חשון",
  marcheshvan: "חשון",
  "mar cheshvan": "חשון",
  kislev: "כסלו",
  tevet: "טבת",
  teves: "טבת",
  shevat: "שבט",
  shvat: "שבט",
  adar: "אדר",
  "adar i": ADAR_I,
  "adar 1": ADAR_I,
  "adar a": ADAR_I,
  "adar alef": ADAR_I,
  "adar rishon": ADAR_I,
  "adar ii": ADAR_II,
  "adar 2": ADAR_II,
  "adar b": ADAR_II,
  "adar bet": ADAR_II,
  "adar sheni": ADAR_II,
  nisan: "ניסן",
  nissan: "ניסן",
  iyar: "אייר",
  iyyar: "אייר",
  sivan: "סיון",
  tamuz: "תמוז",
  tammuz: "תמוז",
  av: "אב",
  "menachem av": "אב",
  elul: "אלול",
};

/** "Adar-II", " adar  ii " and "Sh'vat" all find their month: letters and digits only, lower-case, single spaces. */
function monthKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A month's English transliteration, however it is spelled, as the Hebrew we print; null when it is not a month we know. */
export function hebrewMonthName(english: string | null | undefined): string | null {
  return MONTHS[monthKey(english ?? "")] ?? null;
}

const parts = new Intl.DateTimeFormat("en-u-ca-hebrew-nu-latn", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const hebrewMonth = new Intl.DateTimeFormat("he-u-ca-hebrew-nu-latn", { month: "long", timeZone: "UTC" });

type HebrewParts = { day: number; month: string; year: number };

/** The Hebrew day, month (in Hebrew) and year of a YYYY-MM-DD key; null when the key is not a date or the runtime has no Hebrew calendar. */
function partsOf(key: string): HebrewParts | null {
  const [y, m, d] = key.slice(0, 10).split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  if (Number.isNaN(at.getTime())) return null;
  try {
    const found = Object.fromEntries(parts.formatToParts(at).map((p) => [p.type, p.value]));
    const day = Number(found.day);
    const year = Number(found.year);
    // A runtime without the Hebrew calendar answers with the civil year.
    if (!Number.isInteger(day) || !Number.isInteger(year) || year < 5000) return null;
    return { day, month: hebrewMonthName(found.month) ?? hebrewMonth.format(at), year };
  } catch {
    return null;
  }
}

/** The thousands are left unwritten, as on any printed date: 5787 → תשפ״ז. */
function yearLetters(year: number): string {
  return gematria(year % 1000);
}

/** The Hebrew date of a YYYY-MM-DD key, or null when the key is not a date or the runtime has no Hebrew calendar. */
export function hebrewDate(key: string): string | null {
  const p = partsOf(key);
  return p ? `${gematria(p.day)} ${p.month} ${yearLetters(p.year)}` : null;
}

/** The Hebrew day and month of a YYYY-MM-DD key, without the year: "י״ג כסלו". For a row in a list of days. */
export function hebrewDayMonth(key: string): string | null {
  const p = partsOf(key);
  return p ? `${gematria(p.day)} ${p.month}` : null;
}

function wholeNumber(v: string | number | null | undefined): number | null {
  const n = typeof v === "number" ? v : /^\s*\d{1,4}\s*$/.test(v ?? "") ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
}

/** Hebrew letters, geresh and gershayim (and plain ' and ") kept; niqqud and cantillation (U+0591 to U+05C7) dropped. */
const MARKS = new RegExp(`[${String.fromCharCode(0x591)}-${String.fromCharCode(0x5c7)}]`, "g");
const HEBREW_LETTER = new RegExp(`[${String.fromCharCode(0x5d0)}-${String.fromCharCode(0x5ea)}]`);

/** The Hebrew-letters part of the record's own text date, without niqqud: "ז׳ בֶּאֱלוּל תשנ״ז" or "30th of Nisan, 5749 - ל׳ בְּנִיסָן תשמ״ט"; null when there is none. */
function recordedText(text: string | null | undefined): string | null {
  if (!text) return null;
  const part = text.includes(" - ") ? text.slice(text.lastIndexOf(" - ") + 3) : text;
  const clean = part.replace(MARKS, "").replace(/\s+/g, " ").trim();
  return HEBREW_LETTER.test(clean) ? clean : null;
}

/**
 * A date of death as it is written on a memorial: "י׳ בטבת תשפ״ג". Never uses the record's
 * Hebrew_Year__c, which holds the year of the next observance, not of the death.
 * 1. The record's own Hebrew text date (true day, month and year), niqqud removed.
 * 2. Else the civil date converted; if its day or month differs from the record's (a death
 *    after sunset), the record's day and month with no year.
 * 3. Else the record's day and month alone, or null.
 */
export function hebrewDateOfDeath(recorded: { text?: string | null; day?: string | number | null; month?: string | null }, civil?: string | null): string | null {
  const text = recordedText(recorded.text);
  if (text) return text;
  const day = wholeNumber(recorded.day);
  const month = hebrewMonthName(recorded.month);
  const recordedDayMonth = day !== null && day >= 1 && day <= 30 && month ? `${gematria(day)} ב${month}` : null;
  const p = civil ? partsOf(civil) : null;
  if (p) {
    if (recordedDayMonth && (p.day !== day || p.month !== month)) return recordedDayMonth;
    return `${gematria(p.day)} ב${p.month} ${yearLetters(p.year)}`;
  }
  return recordedDayMonth;
}
