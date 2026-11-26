/**
 * An invented copy of the old Mitzvah Corps spreadsheet, in the shape the import reads: every tab and its quirks
 * (line breaks in headers, "*" marks, seven-digit phones, ragged rows, a title row per block, a stray row above a
 * header). Every name, address and contact is made up. Real rows are personal data and never belong in the repo.
 */
export const SHEET_HEADER = [
  "Zip Code",
  "First Name",
  "Last Name",
  "Address",
  "phone #1\n(314 unless noted otherwise)",
  "phone #2",
  "e-mail",
  "times/yr",
  "Bake challah,\nsweets",
  "Make meals",
  "Make soup",
  "Nursing home visits",
  "Home or hosp visits",
  "Care pkg to hosp etc.",
  "Walk dog",
  "Errands, grocery shop",
  "Drive",
  "Shiva",
  "Deliver soup etc.",
  "Other care, tasks",
  "Support calls",
  "Pay for meal, etc.",
  "notes",
  "additional info",
  "responded/date",
  "date info entered",
  "Welcome email sent (Chair only)",
];

/** A row of the "MC Volunteers" tab: the offer columns are given by their header. */
export function sheetRow(p: { zip?: string; first: string; last: string; address?: string; phone1?: string; phone2?: string; email?: string; times?: string; offers?: Record<string, string>; notes?: string; info?: string; responded?: string; entered?: string }): string[] {
  const row = [p.zip ?? "", p.first, p.last, p.address ?? "", p.phone1 ?? "", p.phone2 ?? "", p.email ?? "", p.times ?? ""];
  for (const h of SHEET_HEADER.slice(8, 22)) row.push(p.offers?.[h] ?? "");
  row.push(p.notes ?? "", p.info ?? "", p.responded ?? "", p.entered ?? "");
  // Ragged, as the API returns it: trailing empty cells are left off.
  while (row.length && row[row.length - 1] === "") row.pop();
  return row;
}

const FORM_OFFERS = [
  "Bake challah or sweets",
  "Provide a meal for a member/family",
  "Provide a vegetarian / vegan meal",
  "Provide a gluten-free meal",
  "Pay for meal delivery, e.g., Door Dash",
  "Deliver chicken soup/challah/meal",
  "Provide and deliver care package (e.g., to someone in the hospital)",
  "Pet sit (e.g., while someone is in the hospital)",
  "Walk dog (e.g., for someone recovering from surgery)",
  "Grocery shop or run errands (e.g., pharmacy)",
  "Set up shiva or receive deliveries",
  "Drive a member to a medical appointment or CRC",
  "Make supportive telephone calls",
  "Provide tech support to a member in need",
  "Other caring or necessary tasks that arise",
];

export const FORM_HEADER = [
  "Timestamp",
  "Email Address",
  "First Name",
  "Last Name",
  "Best phone number to reach you",
  "Is it ok to text you at the number provided?",
  "What is your home address with zip code?",
  "What is your work address with zip code? (optional)",
  ...FORM_OFFERS.map((o) => `How can you help? [${o}]`),
  "How often are you willing to help?",
  "What else should Mitzvah Corps know about you? (e.g., skills, languages)",
  "Are you interested in serving as a Coordinator?",
  "How can you help? [Helping new parents]",
];

export function formRow(p: { at: string; email: string; first: string; last: string; phone?: string; text?: string; home?: string; work?: string; offers?: number[]; often?: string; more?: string; coordinator?: string; newParents?: boolean }): string[] {
  return [p.at, p.email, p.first, p.last, p.phone ?? "", p.text ?? "", p.home ?? "", p.work ?? "", ...FORM_OFFERS.map((_, i) => (p.offers?.includes(i) ? "Yes" : "")), p.often ?? "", p.more ?? "", p.coordinator ?? "", p.newParents ? "Yes" : ""];
}

/** The whole invented spreadsheet. */
export function sampleSheet() {
  return {
    tabs: {
      "MC Volunteers": [
        SHEET_HEADER,
        sheetRow({ zip: "63130", first: "Rina*", last: "Stein", address: "1 Elm St", phone1: "555-0168", email: "Rina.Stein@Example.test", times: "4", offers: { "Make meals": "X", "Nursing home visits": "video", Drive: "X", "Walk dog": "X" }, notes: "Prefers mornings", responded: "meal for Ploni Almoni 3/22", entered: "1/5/2023" }),
        sheetRow({ zip: "63105", first: "Avi", last: "Mor", phone1: "(636) 555-0101", times: "2-3", offers: { "Support calls": "X", Shiva: "X" } }),
        sheetRow({ first: "Noa", last: "Levi", phone1: "314-555-0150", offers: { "Bake challah,\nsweets": "X" } }),
        ["", "", "", "just a stray note in the address column"],
        [],
      ],
      "Volunteer Form Responses": [
        FORM_HEADER,
        formRow({ at: "3/22/2025 14:05:01", email: "rina.stein@example.test", first: "Rina", last: "Stein", phone: "314-555-0168", text: "Yes", home: "1 Elm St, St. Louis, MO 63130", offers: [0, 2, 11], often: "Once a month", more: "Speaks Spanish", coordinator: "Yes" }),
        formRow({ at: "4/2/2025 9:00:00", email: "dov@example.test", first: "Dov", last: "Katz", phone: "314.555.0199", text: "No", offers: [8, 13], newParents: true }),
      ],
      Drivers: [
        ["these are members who are willing to drive; they may or may not be Mitzvah Corps volunteers"],
        ["63112", "Avi", "Mor", "avi.mor@example.test"],
        ["63117", "Gil", "Paz", "gil@example.test", "555-0123", "evenings only"],
      ],
      "Special situations": [
        ["Dog walking for Ploni Almoni Feb 2023"],
        ["Zip", "First Name", "Last Name", "Address", "phone", "E-mail", "Notes"],
        ["63130", "Noa", "Levi", "", "314-555-0150", "", "walked Tuesdays"],
        [],
        ["Rides for Almonit Feb 2024"],
        ["Zip", "First Name", "Last Name", "Address", "phone", "E-mail", "Notes"],
        ["63117", "Gil", "Paz", "", "", "gil@example.test"],
      ],
      "IL members": [
        ["Most of the people listed here have NOT volunteered. A * after a first name means they are a Mitzvah Corps volunteer."],
        ["Zip", "First Name", "Last Name", "Address", "City", "phone #1", "phone #2", "e-mail #1", "e-mail #2"],
        ["63124", "Hana*", "Bar", "9 Oak Ave", "Ladue", "314-555-0177", "", "hana@example.test", "hana.bar@example.test"],
        ["63124", "Eli", "Bar", "9 Oak Ave", "Ladue", "314-555-0177"],
      ],
      "Other volunteers": [
        ["63110", "Tal", "Ron", "4 Pine Rd", "St. Louis", "", "314-555-0111", "tal@example.test", "", "soup for Ploni 5/1"],
        ["Zip", "First Name", "Last Name", "Address", "City", "phone/home", "phone /cell", "e-mail", "notes", "responded/date"],
        ["63110", "Maya", "Ron", "4 Pine Rd", "St. Louis", "314-555-0112", "", "", "knits"],
      ],
      "Copy of Old Form 2019": [["Timestamp", "Name"], ["1/1/2019", "Someone"]],
      "Budget 2024": [["Line", "Amount"]],
    },
  };
}
