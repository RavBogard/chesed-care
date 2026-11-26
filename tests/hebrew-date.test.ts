import { describe, expect, it } from "vitest";
import { gematria, hebrewDate, hebrewDateOfDeath, hebrewDayMonth, hebrewMonthName } from "@/lib/hebrew-date";

describe("hebrewDate", () => {
  it("writes the day and year in letters and drops the thousands", () => {
    expect(hebrewDate("2026-11-23")).toBe("י״ג כסלו תשפ״ז");
  });

  it("writes Rosh Hashanah 5787 with a geresh on the single letter", () => {
    expect(hebrewDate("2026-09-12")).toBe("א׳ תשרי תשפ״ז");
  });

  it("writes the 15th and 16th as 9+6 and 9+7", () => {
    // 15 and 16 Kislev 5787.
    expect(hebrewDate("2026-11-25")).toBe("ט״ו כסלו תשפ״ז");
    expect(hebrewDate("2026-11-26")).toBe("ט״ז כסלו תשפ״ז");
  });

  it("names both Adars in a leap year and plain Adar otherwise", () => {
    // 5787 is a leap year: Purim is 14 Adar II (2027-03-23).
    expect(hebrewDate("2027-03-23")).toBe("י״ד אדר ב׳ תשפ״ז");
    expect(hebrewDate("2027-02-21")).toBe("י״ד אדר א׳ תשפ״ז");
    // 5786 is not: Purim is 14 Adar (2026-03-03).
    expect(hebrewDate("2026-03-03")).toBe("י״ד אדר תשפ״ו");
  });

  it("gives the last day of a 30-day month and the turn of the year", () => {
    expect(hebrewDate("2026-09-11")).toBe("כ״ט אלול תשפ״ו");
    expect(hebrewDate("2026-11-10")).toBe("ל׳ חשון תשפ״ז");
  });

  it("is null for something that is not a date", () => {
    expect(hebrewDate("not-a-date")).toBeNull();
  });
});

describe("hebrewDayMonth", () => {
  it("gives the day and month without the year", () => {
    expect(hebrewDayMonth("2026-11-23")).toBe("י״ג כסלו");
    expect(hebrewDayMonth("not a date")).toBeNull();
  });
});

describe("hebrewMonthName", () => {
  it("reads every month in the spellings Salesforce holds, whatever the case or spacing", () => {
    const spellings: Record<string, string[]> = {
      תשרי: ["Tishrei", "Tishri"],
      חשון: ["Cheshvan", "Heshvan", "Marcheshvan", "MARCHESHVAN"],
      כסלו: ["Kislev"],
      טבת: ["Tevet", "Teves", " tevet "],
      שבט: ["Shevat", "Shvat", "Sh'vat"],
      אדר: ["Adar"],
      "אדר א׳": ["Adar I", "Adar 1", "Adar Rishon", "adar  i", "Adar-I"],
      "אדר ב׳": ["Adar II", "Adar 2", "Adar Sheni", "ADAR II"],
      ניסן: ["Nisan", "Nissan"],
      אייר: ["Iyar", "Iyyar"],
      סיון: ["Sivan"],
      תמוז: ["Tamuz", "Tammuz"],
      אב: ["Av"],
      אלול: ["Elul"],
    };
    for (const [hebrew, names] of Object.entries(spellings)) for (const name of names) expect(hebrewMonthName(name), name).toBe(hebrew);
  });

  it("does not guess at a month it does not know", () => {
    for (const name of ["", "December", "Adar III", null, undefined]) expect(hebrewMonthName(name)).toBeNull();
  });
});

describe("hebrewDateOfDeath", () => {
  const withNiqqud = "ז׳ בֶּאֱלוּל תשנ״ז";
  const english = "30th of Nisan, 5749 - ל׳ בְּנִיסָן תשמ״ט";

  it("takes the record's own text date, without niqqud, in both shapes", () => {
    expect(hebrewDateOfDeath({ text: withNiqqud })).toBe("ז׳ באלול תשנ״ז");
    expect(hebrewDateOfDeath({ text: english })).toBe("ל׳ בניסן תשמ״ט");
    expect(hebrewDateOfDeath({ text: "  ז׳   בֶּאֱלוּל  תשנ״ז " })).toBe("ז׳ באלול תשנ״ז");
  });

  it("never prints the current Hebrew year for a death decades ago", () => {
    const current = "תשפ״ז";
    const out = hebrewDateOfDeath({ text: withNiqqud, day: "7", month: "Elul" }, "1997-09-09");
    expect(out).not.toContain(current);
    expect(out).toContain("תשנ״ז");
    // Without the text, the converted civil year is the year of death, not this year.
    expect(hebrewDateOfDeath({ day: "7", month: "Elul" }, "1997-09-09")).not.toContain(current);
  });

  it("ignores a text with no Hebrew letters and falls back", () => {
    expect(hebrewDateOfDeath({ text: "30th of Nisan, 5749" }, "2026-11-23")).toBe("י״ג בכסלו תשפ״ז");
  });

  it("converts the civil date when the recorded day and month match it", () => {
    expect(hebrewDateOfDeath({ day: "13", month: "Kislev" }, "2026-11-23")).toBe("י״ג בכסלו תשפ״ז");
    expect(hebrewDateOfDeath({}, "2026-11-23")).toBe("י״ג בכסלו תשפ״ז");
  });

  it("prints the record's day and month with no year when the civil date disagrees (after sunset)", () => {
    expect(hebrewDateOfDeath({ day: "14", month: "Kislev" }, "2026-11-23")).toBe("י״ד בכסלו");
    expect(hebrewDateOfDeath({ day: "13", month: "Tevet" }, "2026-11-23")).toBe("י״ג בטבת");
  });

  it("prints the record's day and month alone with no civil date, or nothing", () => {
    expect(hebrewDateOfDeath({ day: "10", month: "Tevet" })).toBe("י׳ בטבת");
    expect(hebrewDateOfDeath({ day: 15, month: "Adar II" }, "unknown")).toBe("ט״ו באדר ב׳");
    expect(hebrewDateOfDeath({})).toBeNull();
    expect(hebrewDateOfDeath({ day: "x", month: "Tevet" }, null)).toBeNull();
    expect(hebrewDateOfDeath({}, "unknown")).toBeNull();
  });
});

describe("gematria", () => {
  it("handles tens, hundreds and the two special cases", () => {
    expect(gematria(1)).toBe("א׳");
    expect(gematria(10)).toBe("י׳");
    expect(gematria(15)).toBe("ט״ו");
    expect(gematria(16)).toBe("ט״ז");
    expect(gematria(30)).toBe("ל׳");
    expect(gematria(786)).toBe("תשפ״ו");
    expect(gematria(800)).toBe("ת״ת");
    expect(gematria(716)).toBe("תשט״ז");
  });
});
