/**
 * The roster import's readers and merge, with no database: every tab shape and its quirks, the cleaning of cells, the
 * row fingerprints, and the rule for when two rows are the same person. All names and contacts are invented.
 */
import { describe, expect, it } from "vitest";
import { LIMITS, cell, emailsIn, fit, howOftenOf, phonesIn, sheetTimestamp, splitName } from "@/server/volunteers/import/cells";
import { matchOf, mergePeople, sameFirstName } from "@/server/volunteers/import/merge";
import { readDriversTab, readFormTab, readSpecialTab, readTab, tabKind } from "@/server/volunteers/import/tabs";
import { readTable } from "@/server/volunteers/import/table";
import { SHEET_OFFERS } from "@/server/volunteers/import/offers";
import { fingerprintOf, previewFile, readFile } from "@/server/volunteers/import/run";
import { summaryLines } from "@/server/volunteers/import/report";
import { FORM_HEADER, SHEET_HEADER, formRow, sampleSheet, sheetRow } from "./support/roster-sheet";

describe("cells", () => {
  it("strips '*' marks from a name and keeps them", () => {
    expect(splitName(" Rina** ")).toEqual({ name: "Rina", markers: ["**"] });
    expect(splitName("Avi")).toEqual({ name: "Avi", markers: [] });
  });

  it("strips control, zero-width and bidirectional characters", () => {
    expect(cell("Ri‮na​\u0007 Stein⁦")).toBe("Rina Stein");
  });

  it("cuts a value to the app's limit and hands over the whole of it, so nothing is dropped", () => {
    const kept: string[] = [];
    const long = "A".repeat(LIMITS.firstName + 5);
    expect(fit(long, LIMITS.firstName, (w) => kept.push(w))).toHaveLength(LIMITS.firstName);
    expect(kept).toEqual([long]);
    expect(fit("Rina", LIMITS.firstName, () => kept.push("no"))).toBe("Rina");
  });

  it("reads seven-digit phones as area code 314, and every other way a number is written", () => {
    expect(phonesIn("555-0168")).toEqual(["314-555-0168"]);
    expect(phonesIn("(636) 555-0101 cell")).toEqual(["636-555-0101"]);
    expect(phonesIn("314.555.0199 / 555 0123")).toEqual(["314-555-0199", "314-555-0123"]);
    expect(phonesIn("1-314-555-0100")).toEqual(["314-555-0100"]);
    expect(phonesIn("63130")).toEqual([]);
    expect(phonesIn("someone@example.test")).toEqual([]);
  });

  it("lower-cases and checks emails, and finds more than one in a cell", () => {
    expect(emailsIn("Rina.Stein@Example.test; other@Example.test")).toEqual(["rina.stein@example.test", "other@example.test"]);
    expect(emailsIn("not an email @ all")).toEqual([]);
  });

  it("maps plain 'how often' words and numbers to the roster's choice, asking no more often than they said", () => {
    expect(howOftenOf("4")).toBe("quarterly");
    expect(howOftenOf("2-3")).toBe("twice_a_year");
    expect(howOftenOf("12")).toBe("monthly");
    expect(howOftenOf("Once a month")).toBe("monthly");
    expect(howOftenOf("whenever you need me")).toBe("as_needed");
    expect(howOftenOf("it depends")).toBeNull();
  });

  it("reads the form's timestamp", () => {
    expect(sheetTimestamp("3/22/2025 14:05:01")).toBe("2025-03-22T14:05:01.000Z");
    expect(sheetTimestamp("1/5/23")).toBe("2023-01-05T12:00:00.000Z");
    expect(sheetTimestamp("soon")).toBeNull();
  });
});

describe("tabs", () => {
  it("knows each tab by name, ignores old form copies, and reports any other tab", () => {
    expect(tabKind("MC Volunteers")).toBe("sheet");
    expect(tabKind(" volunteer form responses ")).toBe("form");
    expect(tabKind("Copy of Old Form 2019")).toBe("ignore");
    expect(tabKind("Budget")).toBeNull();
    const { summary } = readFile(sampleSheet());
    expect(summary.ignoredTabs).toEqual(["Copy of Old Form 2019"]);
    expect(summary.unknownTabs).toEqual(["Budget 2024"]);
    expect(() => readFile({ rows: [] })).toThrow();
  });

  it("MC Volunteers: headers with line breaks, offers marked X or in words, the history kept apart, ragged rows", () => {
    const r = readTable("MC Volunteers", [SHEET_HEADER, sheetRow({ zip: "63130", first: "Rina*", last: "Stein", phone1: "555-0168", phone2: "314-555-0102", email: "Rina@Example.test", times: "4", offers: { "Make meals": "X", "Nursing home visits": "video", "Walk dog": "X", Shiva: "X", "Deliver soup etc.": "X", "Pay for meal, etc.": "X" }, notes: "Prefers mornings", info: "Retired nurse", responded: "meal for Ploni Almoni 3/22", entered: "1/5/2023" })], { offers: SHEET_OFFERS });
    expect(r.unparsed).toEqual([]);
    expect(r.people[0]).toMatchObject({
      row: 2,
      firstName: "Rina",
      lastName: "Stein",
      markers: ["*"],
      emails: ["rina@example.test"],
      phones: ["314-555-0168", "314-555-0102"],
      zip: "63130",
      canDo: ["meals", "visits", "pet_care", "shiva_help", "deliveries"],
      offers: ["Nursing home visits: video", "Walk dog", "Pay for a meal"],
      frequency: "4",
      howOften: "quarterly",
      notes: ["Prefers mornings", "Retired nurse"],
      history: ["meal for Ploni Almoni 3/22"],
      enteredAt: "2023-01-05T12:00:00.000Z",
    });
  });

  it("MC Volunteers: an offer column the app does not know is kept as words and reported", () => {
    const header = [...SHEET_HEADER.slice(0, 8), "Knit blankets"];
    const r = readTable("MC Volunteers", [header, ["63130", "Noa", "Levi", "", "", "", "", "", "X"]], { offers: SHEET_OFFERS });
    expect(r.people[0].offers).toEqual(["Knit blankets"]);
    expect(r.unmappedOffers).toEqual(["Knit blankets"]);
  });

  it("Volunteer Form Responses: columns found by their question, Yes answers mapped, ok to text and coordinator kept", () => {
    const shuffled = [FORM_HEADER[2], FORM_HEADER[3], ...FORM_HEADER.filter((_, i) => i !== 2 && i !== 3)];
    const row = formRow({ at: "3/22/2025 14:05:01", email: "Dov@Example.test", first: "Dov", last: "Katz", phone: "314.555.0199", text: "No", home: "2 Ash St, St. Louis, MO 63130", work: "1 Office Pl 63101", offers: [1, 3, 5, 8, 10, 11, 12, 13], often: "Once a month", more: "Speaks Spanish", coordinator: "Yes", newParents: true });
    const moved = [row[2], row[3], ...row.filter((_, i) => i !== 2 && i !== 3)];
    const r = readFormTab("Volunteer Form Responses", [shuffled, moved]);
    expect(r.people[0]).toMatchObject({
      firstName: "Dov",
      lastName: "Katz",
      emails: ["dov@example.test"],
      phones: ["314-555-0199"],
      okToText: false,
      coordinatorInterest: true,
      zip: "63130",
      howOften: "monthly",
      formAt: "2025-03-22T14:05:01.000Z",
      notes: ["Work address: 1 Office Pl 63101", "Speaks Spanish"],
      canDo: ["meals", "deliveries", "pet_care", "shiva_help", "rides", "calls", "tech_help"],
      offers: ["Gluten-free meal", "Walk dog", "Helping new parents"],
    });
    expect(r.unmappedOffers).toEqual([]);
  });

  it("Drivers: no header, a note first, an '@' cell is an email and a phone-looking cell a phone; all can drive", () => {
    const r = readDriversTab("Drivers", [["these are members who are willing to drive"], ["63117", "Gil", "Paz", "gil@example.test", "555-0123", "evenings only"], ["63112", "Avi", "Mor"]]);
    expect(r.unparsed).toEqual([]);
    expect(r.people.map((p) => [p.row, p.firstName, p.emails, p.phones, p.canDo, p.notes])).toEqual([
      [2, "Gil", ["gil@example.test"], ["314-555-0123"], ["rides"], ["evenings only"]],
      [3, "Avi", [], [], ["rides"], []],
    ]);
  });

  it("Special situations: repeated blocks; each title and the notes go to the lead and clergy-only history", () => {
    const r = readSpecialTab("Special situations", sampleSheet().tabs["Special situations"]);
    expect(r.people.map((p) => [p.firstName, p.history, p.notes])).toEqual([
      ["Noa", ["Dog walking for Ploni Almoni Feb 2023", "walked Tuesdays"], []],
      ["Gil", ["Rides for Almonit Feb 2024"], []],
    ]);
  });

  it("IL members: the note above the header is skipped; without a '*' a person has not volunteered", () => {
    const r = readTab("il", "IL members", sampleSheet().tabs["IL members"]);
    expect(r.unparsed).toEqual([]);
    expect(r.people[0]).toMatchObject({ row: 3, firstName: "Hana", markers: ["*"], notVolunteered: false, city: "Ladue", emails: ["hana@example.test", "hana.bar@example.test"], phones: ["314-555-0177"] });
    expect(r.people[1]).toMatchObject({ firstName: "Eli", notVolunteered: true });
  });

  it("Other volunteers: the header is found by its content, and the stray row above it is read too", () => {
    const r = readTab("other", "Other volunteers", sampleSheet().tabs["Other volunteers"]);
    expect(r.people.map((p) => [p.row, p.firstName, p.phones, p.history, p.notes])).toEqual([
      [1, "Tal", ["314-555-0111"], ["soup for Ploni 5/1"], []],
      [3, "Maya", ["314-555-0112"], [], ["knits"]],
    ]);
  });

  it("a row with something in it but no name is reported by tab and row number", () => {
    const { summary } = readFile(sampleSheet());
    expect(summary.unparsed).toEqual([{ tab: "MC Volunteers", row: 5 }]);
  });

  it("a row's fingerprint depends on its tab and content, not its position, case or spacing", () => {
    const row = ["63130", "Noa", "Levi", "", ""];
    expect(fingerprintOf("MC Volunteers", row)).toBe(fingerprintOf("mc volunteers", ["63130", " NOA ", "levi"]));
    expect(fingerprintOf("MC Volunteers", row)).not.toBe(fingerprintOf("Other volunteers", row));
    expect(fingerprintOf("MC Volunteers", row)).not.toBe(fingerprintOf("MC Volunteers", ["63130", "Noa", "Levy"]));
  });
});

describe("merging", () => {
  const p = (o: Partial<{ firstName: string; lastName: string | null; emails: string[]; phones: string[] }>) => ({ firstName: "Ann", lastName: "Cohen", emails: [], phones: [], ...o });

  it("exact only on a shared contact AND the same, non-empty first name", () => {
    expect(matchOf(p({ emails: ["a@x.test"] }), p({ firstName: "ann*", lastName: "Other", emails: ["a@x.test"] }))).toBe("exact");
    expect(matchOf(p({ phones: ["314-555-0101"] }), p({ lastName: null, phones: ["314-555-0101"] }))).toBe("exact");
    expect(sameFirstName("Ann", " ANN* ")).toBe(true);
    expect(sameFirstName("Rob", "Robert")).toBe(false);
    expect(sameFirstName("", "")).toBe(false);
  });

  it("a shared contact with another or no first name, or a name alone, is only partial", () => {
    expect(matchOf(p({ phones: ["314-555-0101"] }), p({ firstName: "Bob", phones: ["314-555-0101"] }))).toBe("partial");
    expect(matchOf(p({ emails: ["a@x.test"] }), p({ firstName: "", emails: ["a@x.test"] }))).toBe("partial");
    expect(matchOf(p({}), p({ emails: ["a@x.test"] }))).toBe("partial");
    expect(matchOf(p({ emails: ["a@x.test"] }), p({ firstName: "Bob", lastName: "Levi", emails: ["b@x.test"] }))).toBeNull();
  });

  it("merges across tabs on exact matches only: offers united, every source kept, distinct notes and history", () => {
    const { people } = readFile(sampleSheet());
    const { people: merged, possibleDuplicates } = mergePeople(people);
    expect(merged).toHaveLength(10);
    const rina = merged.find((m) => m.lastName === "Stein")!;
    expect(rina).toMatchObject({ firstName: "Rina", sources: ["MC Volunteers", "Volunteer Form Responses"], emails: ["rina.stein@example.test"], phones: ["314-555-0168"], markers: ["*"], coordinatorInterest: true, okToText: true, howOften: "monthly", notVolunteered: false });
    expect(rina.fingerprints).toHaveLength(2);
    expect(rina.canDo.sort()).toEqual(["baking", "meals", "pet_care", "rides", "visits"]);
    expect(rina.notes).toEqual(["Speaks Spanish", "Prefers mornings"]);
    expect(rina.history).toEqual(["meal for Ploni Almoni 3/22"]);
    expect(merged.find((m) => m.firstName === "Noa")!.sources).toEqual(["MC Volunteers", "Special situations"]);
    // Avi Mor: one row has a phone, the other an email, nothing shared. Two people, listed for a person to check.
    expect(merged.filter((m) => m.firstName === "Avi")).toHaveLength(2);
    expect(possibleDuplicates).toEqual([[{ tab: "MC Volunteers", row: 3 }, { tab: "Drivers", row: 2 }]]);
    // Hana and Eli Bar share a home phone and stay two people; Eli has not volunteered.
    expect(merged.filter((m) => m.lastName === "Bar").map((m) => [m.firstName, m.notVolunteered])).toEqual([["Hana", false], ["Eli", true]]);
  });

  it("the same row twice is one person, even with no contact", () => {
    const sheet = { tabs: { "MC Volunteers": [SHEET_HEADER, sheetRow({ first: "Yael", last: "Gold" }), sheetRow({ first: "Yael", last: "Gold" })] } };
    expect(mergePeople(readFile(sheet).people).people).toHaveLength(1);
  });
});

describe("the dry-run summary", () => {
  it("says counts and row numbers, and no name, contact, unknown tab's name or history, unless a sample is asked for", () => {
    const lines = summaryLines(previewFile(sampleSheet())).join("\n");
    expect(lines).toContain("People after merging: 10");
    expect(lines).toContain("MC Volunteers row 5");
    expect(lines).toContain("tabs this import does not know: 1");
    expect(lines).toContain("MC Volunteers row 3 and Drivers row 2");
    expect(lines).not.toMatch(/Budget|Rina|Stein|example\.test|555-0168|Ploni|Almonit|Prefers mornings/);
    const sample = summaryLines(previewFile(sampleSheet(), true)).join("\n");
    expect(sample).toContain("Rina Stein");
    // Even the sample never shows the history: it names members who were helped.
    expect(sample).not.toMatch(/Ploni|Almonit|walked Tuesdays/);
  });
});
