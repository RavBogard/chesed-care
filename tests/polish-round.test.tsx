// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({ markOccasionAction: vi.fn(), unmarkOccasionAction: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { DayAnchorOpener } from "@/components/day-anchor-opener";
import { MarkAnnouncer } from "@/components/mark-announcer";
import { OccasionList } from "@/components/occasion-list";
import type { Occasion } from "@/server/lifecycle/types";

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
  mobile: "314-555-0101",
  phone: null,
  years: 40,
  relationship: null,
  deathDate: null,
};
const show = (items: Occasion[]) =>
  render(
    <MarkAnnouncer>
      <OccasionList items={items} today="2026-11-23" marks={new Set()} drafts={{}} doneLabel="Done" />
    </MarkAnnouncer>,
  );

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("polish round", () => {
  it("a birthday is titled on its card, and with no name line Done ends the button row, after Text", () => {
    show([base]);
    const card = screen.getByTestId("occasion-card");
    const row = within(card).getByTestId("occasion-row");
    const heading = within(card).getByRole("heading", { level: 4 });
    const done = within(row).getByRole("button", { name: /done/i });
    const text = within(row).getByRole("link", { name: /^Text/ });
    // Reading and tab order: the title, then Text, then Done at the end of the row.
    expect(heading.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the Hebrew name faces the title, marked as Hebrew and right to left; with none on file there is nothing in its place", () => {
    show([{ ...base, hebrewName: "רות בת דבורה" }]);
    const hebrew = within(screen.getByTestId("occasion-card")).getByText("רות בת דבורה");
    expect(hebrew.getAttribute("lang")).toBe("he");
    expect(hebrew.getAttribute("dir")).toBe("rtl");
    cleanup();
    show([base]);
    expect(screen.getByTestId("occasion-card").querySelector("[lang]")).toBeNull();
  });

  it("an observer row that is the deceased is not offered as someone to contact", () => {
    show([{ ...base, type: "shloshim", subjectId: "a0Y000000000001AAA", personName: "Sarah Levy", contactName: "Sarah Levy", contactFirstName: "Sarah", household: "Sarah Levy", relationship: "Self", date: "2026-12-10", deathDate: "2026-11-10" }]);
    expect(screen.queryByRole("link", { name: /^Text|^Call|^Open/ })).toBeNull();
    expect(screen.getByText(/No one to contact/)).toBeTruthy();
  });

  it("a #day- link opens its closed day and the hash changing opens another", () => {
    render(
      <>
        <DayAnchorOpener />
        <details id="day-2026-11-25">
          <summary>Wed</summary>
        </details>
        <details id="day-2026-11-26">
          <summary>Thu</summary>
        </details>
      </>,
    );
    const [a, b] = Array.from(document.querySelectorAll("details"));
    Element.prototype.scrollIntoView = vi.fn();
    window.location.hash = "#day-2026-11-26";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(b.open).toBe(true);
    expect(a.open).toBe(false);
  });
});
