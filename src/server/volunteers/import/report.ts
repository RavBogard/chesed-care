/**
 * The import's summary as lines for a terminal. Counts, tab names, the sheet's column labels and row numbers only. The
 * sample (asked for with --sample) shows five people for a person to check, but never their history of whom they
 * helped: only how many lines of it there are, as that names members.
 */
import type { ImportSummary } from "./run";
import type { MergedPerson } from "./types";

const OUTCOME_WORDS: Record<keyof ImportSummary["outcome"], string> = {
  new: "new",
  update: "updated (brought in before, not edited since)",
  unchanged: "unchanged",
  kept_edited: "kept as a person edited them (only sources and history added)",
  linked: "already on the roster another way (only sources and history added)",
  skipped_left: "skipped: left/opted out",
  skipped_ambiguous: "skipped: ambiguous (a name alone, or more than one person on the roster)",
  skipped_contact_clash: "skipped: shares an email or phone with someone on the roster under another first name",
};

export function samplePerson(p: MergedPerson): string[] {
  return [
    `- ${[p.firstName, p.lastName].filter(Boolean).join(" ")}${p.markers.length ? ` (marked ${p.markers.join(" ")})` : ""}`,
    `  from: ${p.sources.join(", ")} (rows ${p.rows.map((r) => `${r.tab} ${r.row}`).join("; ")})`,
    `  emails: ${p.emails.join(", ") || "none"} · phones: ${p.phones.join(", ") || "none"}`,
    `  can do: ${p.canDo.join(", ") || "nothing mapped"}${p.offers.length ? ` · also: ${p.offers.join("; ")}` : ""}`,
    `  ${p.notVolunteered ? "has not volunteered (IL members) · " : ""}area: ${p.zip ?? p.city ?? "none"} · how often: ${p.howOften ?? "not mapped"}${p.frequency ? ` ("${p.frequency}")` : ""}`,
    `  notes: ${p.notes.length} · history lines (lead and clergy only, not shown): ${p.history.length}`,
  ];
}

export function summaryLines(s: Partial<ImportSummary> & Pick<ImportSummary, "tabs" | "merged" | "withoutEmail" | "withoutPhone" | "withoutEither" | "unmappedOffers" | "unparsed" | "ignoredTabs" | "unknownTabs">): string[] {
  const lines = ["Tabs read:", ...s.tabs.map((t) => `  ${t.tab}: ${t.people} people from ${t.rows} rows`)];
  if (s.ignoredTabs.length) lines.push(`Ignored (old form copies): ${s.ignoredTabs.length}`);
  // Only how many: a tab's name could say something about a person.
  if (s.unknownTabs.length) lines.push(`Not imported, tabs this import does not know: ${s.unknownTabs.length}`);
  lines.push(`People after merging: ${s.merged}`, `  without an email: ${s.withoutEmail}`, `  without a phone: ${s.withoutPhone}`, `  with neither: ${s.withoutEither}`);
  if (s.outcome) {
    lines.push("Against the roster:");
    for (const [k, words] of Object.entries(OUTCOME_WORDS)) lines.push(`  ${s.outcome[k as keyof typeof OUTCOME_WORDS]} ${words}`);
    lines.push(`  ${s.sharedContacts ?? 0} written with a contact someone else holds (kept as their other email or phone)`);
  }
  const where = (w: { tab: string; row: number }) => `${w.tab} row ${w.row}`;
  if (s.ambiguousRows?.length) lines.push(`Skipped as ambiguous (a loose match on the roster; add or link them by hand): ${s.ambiguousRows.map(where).join(", ")}`);
  if (s.possibleDuplicates?.length) lines.push(`Same name, no shared contact, kept as separate people (check by hand): ${s.possibleDuplicates.map((g) => g.map(where).join(" and ")).join("; ")}`);
  lines.push(s.unmappedOffers.length ? `Offer columns with no app category (kept as words): ${s.unmappedOffers.join(" | ")}` : "Every offer column is mapped.");
  lines.push(s.unparsed.length ? `Rows that could not be read: ${s.unparsed.map((u) => `${u.tab} row ${u.row}`).join(", ")}` : "Every row with something in it was read.");
  if (s.sample) lines.push("Sample (first 5):", ...s.sample.flatMap(samplePerson));
  if (s.applied !== undefined) lines.push(s.applied ? "Written to the roster. Nobody was emailed." : "Dry run: nothing was written. Add --apply to write.");
  return lines;
}
