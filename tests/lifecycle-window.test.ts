import { describe, expect, it } from "vitest";
import { defaultDraft, normalizePhone, smsHref, textableNumber } from "@/server/lifecycle/sms";
import type { Occasion } from "@/server/lifecycle/types";
import { addDays, chicagoToday, monthDayOrClause, roundedYears, windowDays, windowHit } from "@/server/lifecycle/window";

describe("Chicago calendar day", () => {
  it.each([
    // 9:30pm Chicago on the 23rd is already the 24th in UTC.
    ["2026-11-24T03:30:00Z", "2026-11-23"],
    ["2026-11-24T06:00:00Z", "2026-11-24"],
    // Summer (CDT, UTC-5): 11:59pm Chicago.
    ["2026-07-05T04:59:00Z", "2026-07-04"],
    ["2026-07-05T05:00:00Z", "2026-07-05"],
    // DST starts 2026-03-08 at 2am Chicago (08:00Z); ends 2026-11-01 at 2am CDT (07:00Z).
    ["2026-03-08T07:59:00Z", "2026-03-08"],
    ["2026-03-08T05:59:00Z", "2026-03-07"],
    ["2026-11-01T05:30:00Z", "2026-11-01"],
    ["2026-11-01T04:59:00Z", "2026-10-31"],
    // New Year's Eve in Chicago while UTC is in the new year.
    ["2027-01-01T05:59:59Z", "2026-12-31"],
  ])("%s is %s in Chicago", (instant, day) => {
    expect(chicagoToday(new Date(instant))).toBe(day);
  });
});

describe("windows", () => {
  it("adds days across DST changes and month / year ends", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-29", 5)).toBe("2027-01-03");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("builds a seven-day window across the new year", () => {
    expect(windowDays("2026-12-28", 7).map((e) => e.dateKey)).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  });

  it("matches recurring dates by month and day, with the year of the window day", () => {
    const w = windowDays("2026-12-28", 7);
    expect(windowHit("1980-01-02", w)?.dateKey).toBe("2027-01-02");
    expect(windowHit("1980-12-28", w)?.dateKey).toBe("2026-12-28");
    expect(windowHit("1980-12-27", w)).toBeNull();
    expect(windowHit(null, w)).toBeNull();
    expect(windowHit("garbage", w)).toBeNull();
  });

  it("observes Feb 29 on Feb 28 in a common year, and on Feb 29 in a leap year", () => {
    const common = windowDays("2027-02-27", 3);
    expect(windowHit("1984-02-29", common)?.dateKey).toBe("2027-02-28");
    expect(monthDayOrClause("Birthdate", common)).toContain("(CALENDAR_MONTH(Birthdate) = 2 AND DAY_IN_MONTH(Birthdate) = 29)");
    const leap = windowDays("2028-02-27", 3);
    expect(windowHit("1984-02-29", leap)?.dateKey).toBe("2028-02-29");
    expect(windowHit("1984-02-28", leap)?.dateKey).toBe("2028-02-28");
  });

  it("builds a month/day clause from integers only and refuses odd field names", () => {
    expect(monthDayOrClause("Wedding_Date__c", windowDays("2026-11-23", 2))).toBe(
      "(CALENDAR_MONTH(Wedding_Date__c) = 11 AND DAY_IN_MONTH(Wedding_Date__c) = 23) OR (CALENDAR_MONTH(Wedding_Date__c) = 11 AND DAY_IN_MONTH(Wedding_Date__c) = 24)",
    );
    expect(() => monthDayOrClause("x) OR (1=1", windowDays("2026-11-23", 1))).toThrow();
  });

  it("rounds yahrzeit years", () => {
    expect(roundedYears("2016-12-01", "2026-11-20")).toBe(10);
    expect(roundedYears(null, "2026-11-20")).toBeNull();
  });
});

describe("texting", () => {
  const base: Occasion = {
    type: "birthday",
    date: "2026-11-23",
    subjectId: "003000000000001AAA",
    personName: "Ruth Cohen",
    personFirstName: "Ruth",
    hebrewName: null,
    hebrewDeathDate: null,
    contactHebrewName: null,
    household: "Ruth and Sam Cohen",
    informalGreeting: "Ruth and Sam",
    accountId: "001000000000001AAA",
    contactId: "003000000000001AAA",
    contactName: "Ruth Cohen",
    contactFirstName: "Ruth",
    mobile: "(314) 555-0101",
    phone: null,
    years: 40,
    relationship: null,
    deathDate: null,
  };

  it("normalises US numbers and refuses junk", () => {
    expect(normalizePhone("(314) 555-0101")).toBe("+13145550101");
    expect(normalizePhone("1-314-555-0101")).toBe("+13145550101");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("314-555-0101 ext. 12")).toBe("+13145550101");
    expect(normalizePhone("555-0101")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(textableNumber({ mobile: null, phone: "314.555.0102" })).toBe("+13145550102");
  });

  it("builds an sms: link with the number and an encoded draft", () => {
    expect(smsHref("+13145550101", "Happy birthday, Ruth! & more")).toBe("sms:+13145550101?&body=Happy%20birthday%2C%20Ruth!%20%26%20more");
  });

  it("has a short draft for each occasion type", () => {
    expect(defaultDraft(base, "2026-11-23")).toBe("Happy birthday, Ruth! Wishing you a sweet year ahead.");
    expect(defaultDraft({ ...base, contactId: "003000000000002AAA", contactFirstName: "Sam" }, "2026-11-23")).toContain("Ruth a very happy birthday");
    expect(defaultDraft({ ...base, type: "anniversary" }, "2026-11-23")).toBe("Happy anniversary, Ruth and Sam! Wishing you a year full of joy together.");
    const y = { ...base, type: "yahrzeit" as const, personName: "Abe Cohen", contactFirstName: "Sam" };
    expect(defaultDraft(y, "2026-11-23")).toContain("yahrzeit of Abe Cohen today");
    expect(defaultDraft({ ...y, date: "2026-11-25" }, "2026-11-23")).toContain("this week");
    expect(defaultDraft({ ...y, type: "shloshim" }, "2026-11-23")).toContain("mourn Abe Cohen");
  });
});
