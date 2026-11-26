// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ mark: vi.fn(), unmark: vi.fn() }));
vi.mock("@/app/actions", () => ({ markOccasionAction: actions.mark, unmarkOccasionAction: actions.unmark }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { MarkAnnouncer } from "@/components/mark-announcer";
import { isDone, OccasionList } from "@/components/occasion-list";
import { TodayDates } from "@/components/today-dates";
import { markKey } from "@/server/care/occasion-marks";
import { cleanLabel, kindCounts, toCards } from "@/server/lifecycle/cards";
import type { OccasionsView } from "@/server/lifecycle/occasions";
import type { Occasion } from "@/server/lifecycle/types";

const TODAY = "2026-11-23";
const Y1 = "a0Y000000000001AAA";
const base: Occasion = {
  type: "birthday",
  date: TODAY,
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
const occ = (over: Partial<Occasion>): Occasion => ({ ...base, ...over });
const observer = (n: number, first: string, over: Partial<Occasion> = {}) =>
  occ({ type: "yahrzeit", subjectId: Y1, personName: "Sarah Levy", personFirstName: "Sarah", years: 12, accountId: `00100000000000${n}AAA`, contactId: `00300000000000${n}AAA`, contactName: `${first} Levy`, contactFirstName: first, household: `${first} Levy`, relationship: "Daughter", ...over });
const keyOf = (o: Occasion) => markKey({ occasionType: o.type, subjectId: o.subjectId, sfAccountId: o.accountId ?? "", year: Number(o.date.slice(0, 4)) });
const list = (items: Occasion[], marks: string[] = []) => (
  <MarkAnnouncer>
    <OccasionList items={items} today={TODAY} marks={new Set(marks)} drafts={{}} doneLabel="Done today" />
  </MarkAnnouncer>
);

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  actions.mark.mockReset();
  actions.unmark.mockReset();
});

describe("cards", () => {
  it("each mourner of one yahrzeit is a card of their own; birthdays stay one card each", () => {
    const cards = toCards([observer(2, "Dana"), observer(3, "Noa"), occ({}), occ({ subjectId: "003000000000009AAA", contactId: "003000000000009AAA" })]);
    expect(cards.map((c) => [c.type, c.people.length, c.people[0].contactFirstName])).toEqual([
      ["yahrzeit", 1, "Dana"],
      ["yahrzeit", 1, "Noa"],
      ["birthday", 1, "Ruth"],
      ["birthday", 1, "Ruth"],
    ]);
    expect(new Set(cards.map((c) => c.key)).size).toBe(4);
  });

  it("the mourners of one death stay adjacent, in the order they came in, even when other rows come between", () => {
    const other = observer(4, "Avi", { subjectId: "a0Y000000000002AAA", personName: "Max Adler" });
    const cards = toCards([observer(2, "Dana"), other, occ({}), observer(3, "Noa")]);
    expect(cards.map((c) => c.people[0].contactFirstName)).toEqual(["Dana", "Noa", "Avi", "Ruth"]);
  });

  it("counts cards by kind: one for each mourner", () => {
    expect(kindCounts([observer(2, "Dana"), observer(3, "Noa"), occ({})]).map((k) => [k.type, k.count, k.label])).toEqual([
      ["yahrzeit", 2, "2 yahrzeits"],
      ["birthday", 1, "1 birthday"],
    ]);
  });

  it("placeholders and the congregation's own account are not shown as people", () => {
    expect(cleanLabel("(unnamed)")).toBeNull();
    expect(cleanLabel("Central Reform Congregation")).toBeNull();
    expect(cleanLabel("DECEASED")).toBeNull();
    expect(cleanLabel(" Ruth Cohen ")).toBe("Ruth Cohen");
  });
});

describe("occasion cards", () => {
  it("a yahrzeit is one card per mourner, titled with the mourner, with whose it is on the second line", () => {
    render(list([observer(2, "Dana", { years: 33 })]));
    const card = screen.getByTestId("occasion-card");
    const heading = within(card).getByRole("heading", { level: 4 });
    expect(heading.textContent).toBe("Dana Levy, Yahrzeit of Sarah Levy");
    // The title is the mourner, linked to their page; the deceased is not a link.
    expect(within(heading).getByRole("link", { name: "Dana Levy" }).getAttribute("href")).toBe("/people/003000000000002AAA");
    expect(within(card).getAllByRole("link").map((a) => a.textContent)).toEqual(["Dana Levy", "Text Dana", "Call"]);
    expect(within(card).getByTestId("occasion-whose").textContent).toBe("Daughter: Sarah Levy · 33 years");
    expect(within(card).getAllByTestId("occasion-row")).toHaveLength(1);
  });

  it("two mourners of one yahrzeit are two adjacent cards, each with its own actions and the right deceased in its draft", () => {
    render(list([observer(2, "Dana"), occ({}), observer(3, "Noa")]));
    const cards = screen.getAllByTestId("occasion-card");
    expect(cards.map((c) => within(c).getByRole("heading").textContent)).toEqual(["Dana Levy, Yahrzeit of Sarah Levy", "Noa Levy, Yahrzeit of Sarah Levy", "Birthday: Ruth Cohen"]);
    expect(screen.getByRole("heading", { level: 3, name: /Yahrzeits/ }).textContent).toBe("Yahrzeits · 2");
    expect(within(cards[0]).getByRole("link", { name: "Text Dana" }).getAttribute("href")).toMatch(/^sms:\+13145550101/);
    expect(within(cards[0]).getByRole("link", { name: "Call Dana" }).getAttribute("href")).toBe("tel:+13145550101");
    expect(within(cards[1]).getByRole("link", { name: "Text Noa" })).toBeTruthy();
    expect(within(cards[1]).getByRole("link", { name: "Call Noa" })).toBeTruthy();
    for (const card of cards.slice(0, 2)) expect(within(card).getByTestId("occasion-draft").textContent).toContain("yahrzeit of Sarah Levy");
    expect(within(cards[0]).getByRole("button", { name: "Mark Dana Levy's yahrzeit for Sarah Levy done" })).toBeTruthy();
    expect(within(cards[1]).getByRole("button", { name: "Mark Noa Levy's yahrzeit for Sarah Levy done" })).toBeTruthy();
  });

  it("each mourner's card is marked and unmarked on its own, with the key its row always had", async () => {
    actions.mark.mockResolvedValue({ status: "ok", message: "ok" });
    actions.unmark.mockResolvedValue({ status: "ok", message: "ok" });
    const [dana, noa] = [observer(2, "Dana"), observer(3, "Noa")];
    const first = render(list([dana, noa]));
    fireEvent.click(screen.getByRole("button", { name: "Mark Noa Levy's yahrzeit for Sarah Levy done" }));
    await waitFor(() => expect(actions.mark).toHaveBeenCalledTimes(1));
    const sent = Object.fromEntries((actions.mark.mock.calls[0][1] as FormData).entries());
    expect(sent).toEqual({ occasionType: "yahrzeit", subjectId: Y1, sfAccountId: noa.accountId, sfContactId: noa.contactId, year: "2026" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Noa Levy's yahrzeit for Sarah Levy marked done."));
    first.unmount();
    // Noa's mark closes Noa's card only; Dana's stays open with its actions.
    render(list([dana, noa], [keyOf(noa)]));
    const open = screen.getAllByTestId("occasion-card").filter((c) => !c.closest("[data-testid='done-group']"));
    expect(open.map((c) => within(c).getByRole("heading").textContent)).toEqual(["Dana Levy, Yahrzeit of Sarah Levy"]);
    expect(screen.getByRole("heading", { level: 3, name: /Yahrzeit ·/ }).textContent).toBe("Yahrzeit · 1");
    const group = screen.getByTestId("done-group");
    expect(within(group).getByRole("heading", { level: 4 }).textContent).toBe("Noa Levy, Yahrzeit of Sarah Levy");
    fireEvent.click(within(group).getByRole("button", { name: "Undo Noa Levy's yahrzeit for Sarah Levy done" }));
    await waitFor(() => expect(actions.unmark).toHaveBeenCalledTimes(1));
    expect((actions.unmark.mock.calls[0][1] as FormData).get("sfAccountId")).toBe(noa.accountId);
    expect(actions.mark).toHaveBeenCalledTimes(1);
  });

  it("a memorial with no one to contact stays one card titled with the deceased", () => {
    render(list([observer(2, "Dana", { contactId: null, contactName: null, contactFirstName: null, household: null, mobile: null, relationship: null })]));
    const card = screen.getByTestId("occasion-card");
    expect(within(card).getByRole("heading", { level: 4 }).textContent).toBe("Yahrzeit of Sarah Levy");
    expect(within(card).getByText("No one to contact on file.")).toBeTruthy();
    expect(within(card).queryByRole("link")).toBeNull();
    expect(within(card).getByRole("button", { name: "Mark Sarah Levy's yahrzeit done" })).toBeTruthy();
  });

  it("the second line gives the relationship when it is known, and the dates of a shloshim", () => {
    const first = render(list([observer(2, "Dana", { relationship: null, years: 1 })]));
    expect(screen.getByTestId("occasion-whose").textContent).toBe("Sarah Levy · First yahrzeit");
    first.unmount();
    render(list([observer(2, "Dana", { type: "shloshim", relationship: "Spouse", deathDate: "2026-10-31", date: "2026-11-30", household: "The Levy Family" })]));
    const card = screen.getByTestId("occasion-card");
    expect(within(card).getByRole("heading", { level: 4 }).textContent).toBe("Dana Levy, Shloshim for Sarah Levy");
    expect(within(card).getByTestId("occasion-whose").textContent).toBe("Spouse: Sarah Levy · died Sat, Oct 31 · shloshim ends Mon, Nov 30");
    // The mourner's household stays beneath, off the band.
    expect(within(within(card).getByTestId("occasion-row")).getByText("The Levy Family")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Mark Dana Levy's shloshim for Sarah Levy done" })).toBeTruthy();
  });

  it("memorial cards are told apart from celebrations by their title, not only by tone", () => {
    render(list([observer(2, "Dana"), occ({})]));
    const [yahrzeit, birthday] = screen.getAllByTestId("occasion-card");
    expect(yahrzeit.getAttribute("data-occasion-type")).toBe("yahrzeit");
    expect(within(yahrzeit).getByRole("heading").textContent).toMatch(/yahrzeit/i);
    expect(within(birthday).getByRole("heading").textContent).toBe("Birthday: Ruth Cohen");
    // The kind is a word on every card, beside its icon: never the tone alone.
    for (const [card, word] of [[yahrzeit, "Yahrzeit"], [birthday, "Birthday"]] as const) {
      const tag = card.querySelector("[data-tone]");
      expect(tag?.textContent).toBe(word);
      expect(tag?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("shows whom the text goes to, a preview of the draft, and names Done", () => {
    render(list([occ({})]));
    expect(screen.getByRole("link", { name: "Text Ruth" })).toBeTruthy();
    expect(screen.getByText(/Happy birthday, Ruth/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Mark Ruth.*birthday done/i })).toBeTruthy();
  });

  it("the Hebrew date of death faces the line that names the deceased; with none, nothing", () => {
    const first = render(list([observer(2, "Dana", { hebrewDeathDate: "י׳ בטבת תשפ״ג" })]));
    const facing = screen.getByTestId("occasion-facing");
    expect([...facing.querySelectorAll('[lang="he"][dir="rtl"]')].map((e) => e.textContent)).toEqual(["י׳ בטבת תשפ״ג"]);
    // It shares its line with the deceased, not with the title.
    expect(facing.parentElement?.contains(screen.getByTestId("occasion-whose"))).toBe(true);
    expect(facing.parentElement?.querySelector("h4")).toBeNull();
    first.unmount();
    render(list([observer(2, "Dana")]));
    expect(screen.queryByTestId("occasion-facing")).toBeNull();
    expect(screen.getByTestId("occasion-card").querySelector("[lang]")).toBeNull();
  });

  it("the mourner's title is faced by their own Hebrew name; a name in Latin letters is not marked as Hebrew", () => {
    const first = render(list([observer(2, "Dana", { contactHebrewName: "דנה בת שרה", hebrewDeathDate: "י׳ בטבת תשפ״ג" })]));
    const title = screen.getByRole("heading", { level: 4 });
    expect(title.parentElement?.querySelector('[lang="he"]')?.textContent).toBe("דנה בת שרה");
    expect(screen.getByTestId("occasion-facing").textContent).toBe("י׳ בטבת תשפ״ג");
    first.unmount();
    render(list([observer(2, "Dana", { contactHebrewName: "Dina bat Sarah" })]));
    const latin = within(screen.getByTestId("occasion-card")).getByText("Dina bat Sarah");
    expect(latin.getAttribute("lang")).not.toBe("he");
    expect(latin.getAttribute("dir")).toBe("ltr");
  });

  it("the whole draft is on the page, not cut after the greeting", () => {
    render(list([observer(2, "Dana")]));
    expect(screen.getByTestId("occasion-draft").textContent).toContain("May their memory be a blessing.");
  });

  it("with no number there is no dead control: a link to the person instead", () => {
    render(list([observer(2, "Dana", { mobile: null, phone: null })]));
    expect(screen.queryByRole("link", { name: /^Text/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Dana" }).getAttribute("href")).toBe("/people/003000000000002AAA");
  });

  it("a shloshim row never shows a placeholder or the congregation as the contact", () => {
    const row = occ({ type: "shloshim", subjectId: Y1, personName: "(unnamed)", contactId: null, contactName: null, contactFirstName: null, household: "Central Reform Congregation", relationship: "the deceased's household", mobile: null, deathDate: "2026-11-10", date: "2026-12-10" });
    const { container } = render(list([row]));
    expect(container.textContent).not.toContain("(");
    expect(container.textContent).not.toContain("Central Reform Congregation");
    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe("Shloshim");
  });

  it("a day's cards are gathered by kind in a fixed order, each kind under a heading with its count", () => {
    const anniversary = occ({ type: "anniversary", subjectId: "001000000000008AAA", personName: "Ruth and Sam Cohen" });
    const shloshim = occ({ type: "shloshim", subjectId: "a0Y000000000009AAA", personName: "Max Adler", contactName: "Lea Adler", contactFirstName: "Lea", accountId: "001000000000009AAA", contactId: "003000000000009AAA", deathDate: "2026-10-24" });
    const second = occ({ subjectId: "003000000000007AAA", contactId: "003000000000007AAA", personName: "Eli Stein", personFirstName: "Eli", contactName: "Eli Stein", contactFirstName: "Eli" });
    render(list([anniversary, occ({}), shloshim, observer(2, "Dana"), observer(3, "Noa"), second]));
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Yahrzeits · 2", "Shloshim · 1", "Birthdays · 2", "Anniversary · 1"]);
    expect(screen.getAllByTestId("occasion-card").map((c) => c.getAttribute("data-occasion-type"))).toEqual(["yahrzeit", "yahrzeit", "shloshim", "birthday", "birthday", "anniversary"]);
    // Each kind's cards sit under that kind's heading, titled one level below it.
    const birthdays = screen.getAllByTestId("kind-group").find((g) => g.getAttribute("data-occasion-type") === "birthday") as HTMLElement;
    expect(within(birthdays).getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Birthday: Ruth Cohen", "Birthday: Eli Stein"]);
  });

  it("a kind with no cards has no heading, and a group that is one kind already has none at all", () => {
    const first = render(list([occ({})]));
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Birthday · 1"]);
    first.unmount();
    render(
      <MarkAnnouncer>
        <OccasionList items={[observer(2, "Dana", { type: "shloshim" })]} today={TODAY} marks={new Set()} drafts={{}} doneLabel="Already contacted" grouped={false} />
      </MarkAnnouncer>,
    );
    expect(screen.queryByTestId("kind-group")).toBeNull();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Dana Levy, Shloshim for Sarah Levy");
  });

  it("the done group is headed, keeps the order of kinds, and its kinds leave the headings above", () => {
    const [b, y] = [occ({}), observer(2, "Dana")];
    const anniversary = occ({ type: "anniversary", subjectId: "001000000000008AAA", personName: "Ruth and Sam Cohen" });
    render(list([anniversary, b, y], [keyOf(b), keyOf(y)]));
    const group = screen.getByTestId("done-group");
    expect(within(group).getByRole("heading", { level: 3 }).textContent).toBe("Done today (2)");
    expect(within(group).getAllByTestId("occasion-card").map((c) => c.getAttribute("data-occasion-type"))).toEqual(["yahrzeit", "birthday"]);
    expect(screen.getAllByTestId("kind-group").map((g) => g.getAttribute("data-occasion-type"))).toEqual(["anniversary"]);
  });

  it("done rows move into a closed group and are not faded", () => {
    const [a, b] = [observer(2, "Dana"), observer(3, "Noa")];
    render(list([a, b], [keyOf(a)]));
    const group = screen.getByTestId("done-group") as HTMLDetailsElement;
    expect(group.tagName).toBe("DETAILS");
    expect(group.open).toBe(false);
    expect(within(group).getByRole("button", { name: /Undo/ })).toBeTruthy();
    expect(within(group).queryByRole("link", { name: /^Text/ })).toBeNull();
    expect(within(group).getByTestId("occasion-card").className).not.toContain("opacity");
    expect(within(group).getByTestId("occasion-card").innerHTML.replace("disabled:opacity-60", "")).not.toContain("opacity");
    expect(isDone(new Set([keyOf(a)]), a)).toBe(true);
  });

  it("tapping Text is remembered for the tab: the row says texted and survives a remount", () => {
    const view = render(list([occ({})]));
    expect(screen.getByTestId("occasion-row").getAttribute("data-texted")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Text Ruth" }));
    expect(screen.getByTestId("occasion-row").getAttribute("data-texted")).toBe("true");
    expect(Object.keys(window.sessionStorage).some((k) => k.includes("birthday") && k.endsWith("|2026"))).toBe(true);
    view.unmount();
    render(list([occ({})]));
    expect(screen.getByTestId("occasion-row").getAttribute("data-texted")).toBe("true");
  });

  it("Done is busy while saving and the result is announced in a live region", async () => {
    let finish: (v: unknown) => void = () => {};
    actions.mark.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(list([occ({})]));
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Mark Ruth.*birthday done/i }));
    await waitFor(() => expect((screen.getByRole("button", { name: /Mark Ruth.*birthday done/i }) as HTMLButtonElement).disabled).toBe(true));
    const sent = actions.mark.mock.calls[0][1] as FormData;
    expect(sent.get("occasionType")).toBe("birthday");
    expect(sent.get("year")).toBe("2026");
    finish({ status: "ok", message: "ok" });
    await waitFor(() => expect(status.textContent).toMatch(/Ruth.*done/));
  });

  it("a failed Done says so beside the row and in the live region", async () => {
    actions.mark.mockResolvedValue({ status: "error", message: "Could not save." });
    render(list([occ({})]));
    fireEvent.click(screen.getByRole("button", { name: /Mark Ruth.*birthday done/i }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Could not save."));
    expect(screen.getAllByText("Could not save.").length).toBe(2);
  });

  it("the Done form is a POST before hydration", () => {
    const html = renderToStaticMarkup(list([occ({})]));
    expect(html).toMatch(/<form[^>]*action=/);
  });
});

describe("Today's dates", () => {
  const view: OccasionsView = {
    today: TODAY,
    weekEnd: "2026-11-29",
    todays: [occ({}), observer(2, "Dana"), observer(3, "Noa")],
    mourning: [],
    week: [
      occ({ date: "2026-11-24", subjectId: "003000000000004AAA", contactId: "003000000000004AAA", personName: "Eli Stein", personFirstName: "Eli", contactName: "Eli Stein", contactFirstName: "Eli" }),
      observer(5, "Avi", { date: "2026-11-26", subjectId: "a0Y000000000002AAA" }),
      observer(6, "Tal", { date: "2026-11-26", subjectId: "a0Y000000000002AAA" }),
      occ({ date: "2026-11-26", subjectId: "003000000000007AAA", contactId: "003000000000007AAA" }),
    ],
  };
  const today = (marks: string[] = []) => render(<TodayDates view={view} marks={new Set(marks)} drafts={{}} />);

  it("shows today and tomorrow in full and the rest of the week as one line per day linking to Upcoming", () => {
    today();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toContain("November 23");
    expect(headings.filter((h) => h?.includes("November 23"))).toHaveLength(1);
    expect(headings.some((h) => /tomorrow/i.test(h ?? ""))).toBe(true);
    expect(screen.getByRole("link", { name: "Text Eli" })).toBeTruthy();
    // Thursday's three rows are a single line, not cards.
    expect(screen.getAllByTestId("occasion-card")).toHaveLength(4);
    // Today's yahrzeit comes before its birthday, each under its kind; tomorrow has its own heading.
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Yahrzeits · 2", "Birthday · 1", "Birthday · 1"]);
    const days = within(screen.getByTestId("week-days")).getAllByRole("link");
    expect(days).toHaveLength(1);
    expect(days[0].getAttribute("href")).toBe("/upcoming#day-2026-11-26");
  });

  it("the week line counts each kind on its own tag, icon beside the word, and carries the Hebrew date", () => {
    today();
    const line = within(screen.getByTestId("week-days")).getByRole("link");
    expect(line.textContent).toContain("Thu, Nov 26");
    const kinds = [...line.querySelectorAll("[data-tone]")].map((k) => [k.textContent, k.getAttribute("data-tone")]);
    expect(kinds).toEqual([
      ["2 yahrzeits", "yahrzeit"],
      ["1 birthday", "birthday"],
    ]);
    expect(line.querySelectorAll("[data-tone] svg[aria-hidden='true']")).toHaveLength(2);
    const hebrew = line.querySelector('[lang="he"]');
    expect(hebrew?.getAttribute("dir")).toBe("rtl");
    expect(hebrew?.textContent).toBe("ט״ז כסלו");
  });

  it("tomorrow's heading is faced by its Hebrew date", () => {
    today();
    const heading = screen.getAllByRole("heading", { level: 2 }).find((h) => /tomorrow/i.test(h.textContent ?? ""));
    expect(heading?.parentElement?.querySelector('[lang="he"]')?.textContent).toBe("י״ד כסלו תשפ״ז");
  });

  it("counts what is done today and shows a finished state when everything is", () => {
    const first = today([keyOf(view.todays[0])]);
    expect(screen.getByTestId("today-progress").textContent).toMatch(/3\D+1/);
    expect(screen.queryByTestId("today-finished")).toBeNull();
    first.unmount();
    today(view.todays.map(keyOf));
    expect(screen.getByTestId("today-progress").textContent).toMatch(/3\D+3/);
    expect(screen.getByTestId("today-finished")).toBeTruthy();
  });
});
