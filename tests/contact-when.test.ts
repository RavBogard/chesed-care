import { describe, expect, it } from "vitest";
import { contactOccurredAt } from "@/server/care/contact-when";
import { InvalidInput } from "@/server/care/validate";
import { instantDate } from "@/lib/format";

const now = new Date("2026-11-23T20:00:00Z");

describe("contactOccurredAt", () => {
  it("uses the moment of saving for today or no date", () => {
    expect(contactOccurredAt(undefined, now)).toBe(now);
    expect(contactOccurredAt("", now)).toBe(now);
    expect(contactOccurredAt("2026-11-23", now)).toBe(now);
  });
  it("keeps an earlier day as the same calendar day in Chicago", () => {
    expect(instantDate(contactOccurredAt("2026-11-20", now))).toBe("Nov 20, 2026");
  });
  it("refuses a future or malformed date", () => {
    expect(() => contactOccurredAt("2026-11-24", now)).toThrow(InvalidInput);
    expect(() => contactOccurredAt("tomorrow", now)).toThrow(InvalidInput);
    expect(() => contactOccurredAt("2026-02-31", now)).toThrow(InvalidInput);
  });
});
