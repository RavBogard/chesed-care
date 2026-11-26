/**
 * Pure name handling for the Inbox's matching step: no database, no network, no model.
 * Names arrive "as written" in a message, so they are folded (case, accents,
 * punctuation), split ("Ruth & Ben Cohen" is two people) and compared with a small
 * nickname table kept here in code.
 */

/** Groups of names that mean the same first name. Kept small on purpose. */
const NICKNAME_GROUPS: readonly (readonly string[])[] = [
  ["robert", "rob", "bob", "bobby"],
  ["william", "will", "bill", "billy"],
  ["james", "jim", "jimmy"],
  ["joseph", "joe", "joey"],
  ["david", "dave", "davey"],
  ["daniel", "dan", "danny"],
  ["michael", "mike", "mikey"],
  ["steven", "stephen", "steve"],
  ["thomas", "tom", "tommy"],
  ["benjamin", "ben", "benny"],
  ["samuel", "sam", "sammy"],
  ["elizabeth", "liz", "beth", "betty", "lizzie"],
  ["rebecca", "becky", "becca"],
  ["abigail", "abby", "abbie"],
  ["jennifer", "jen", "jenny"],
  ["katherine", "catherine", "kate", "katie", "kathy"],
  ["susan", "sue", "susie"],
  ["deborah", "debra", "deb", "debbie"],
  ["richard", "rick", "dick", "rich"],
  ["edward", "ed", "eddie"],
  ["anthony", "tony"],
  ["matthew", "matt"],
  ["joshua", "josh"],
  ["jonathan", "jon"],
  ["alexander", "alex"],
  ["nathan", "nathaniel", "nate"],
  ["zachary", "zach"],
  ["abraham", "abe"],
  ["henry", "hank"],
  ["margaret", "maggie", "peggy"],
  ["judith", "judy"],
  ["barbara", "barb"],
];

const GROUP_OF = new Map<string, number>();
NICKNAME_GROUPS.forEach((g, i) => g.forEach((n) => GROUP_OF.set(n, i)));

const TITLES = new Set(["rabbi", "dr", "mr", "mrs", "ms", "mx", "prof", "cantor", "rev", "mister", "miss"]);

/** Lower case, accents and punctuation removed, spaces collapsed. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The folded words of a name, without titles. */
export function nameTokens(name: string): string[] {
  return fold(name)
    .split(" ")
    .filter((t) => t && !TITLES.has(t));
}

/** Whether two folded first names are the same or known nicknames of each other. */
export function sameFirstName(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = GROUP_OF.get(a);
  return ga !== undefined && ga === GROUP_OF.get(b);
}

/** Every folded spelling a first name may have: itself and its nickname group. */
export function variantsOf(token: string): string[] {
  const g = GROUP_OF.get(token);
  return g === undefined ? [token] : [...new Set([token, ...NICKNAME_GROUPS[g]])];
}

/**
 * One written name into the people it names. "Ruth & Ben Cohen" and "Ruth and Ben
 * Cohen" give "Ruth Cohen" and "Ben Cohen"; "Cohen, Ruth" gives "Ruth Cohen". A
 * part with only a first name takes the surname of the last part when that has two or more words.
 */
export function splitNames(written: string): string[] {
  const parts = written
    .normalize("NFC")
    .split(/\s*(?:&|\+|\band\b|\bund\b|,\s*(?=\S+\s+\S+)|;|\/)\s*/iu)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  // "Cohen, Ruth": a comma between exactly two single words is surname, first name.
  const plain = written.trim();
  const flipped = /^([\p{L}'’-]+),\s*([\p{L}'’-]+)$/u.exec(plain);
  if (flipped) return [`${flipped[2]} ${flipped[1]}`];
  const last = nameTokens(parts[parts.length - 1]);
  const surname = last.length >= 2 ? parts[parts.length - 1].trim().split(/\s+/).slice(-1)[0] : null;
  return parts.map((p) => (surname && nameTokens(p).length === 1 ? `${p} ${surname}` : p));
}

/**
 * A candidate is a strong match when every word of the name that was written is a
 * whole word of the candidate's name (the first name may be a known nickname).
 * Nothing partial counts: "Ben" does not match "Benjamin Cohen" by substring, only
 * through the table.
 */
export function isStrongMatch(query: string[], candidateName: string): boolean {
  if (query.length === 0) return false;
  const cand = nameTokens(candidateName);
  const used = new Set<number>();
  return query.every((q, qi) => {
    const i = cand.findIndex((c, ci) => !used.has(ci) && (c === q || (qi === 0 && sameFirstName(c, q))));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}
