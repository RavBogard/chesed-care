import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem, listCareItems } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { createOutsidePerson } from "@/server/care/outside-people";
import { createProposal } from "@/server/care/proposals";
import { updateUser } from "@/server/care/users";
import { contactLog, followUps, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/" }));

const household: SfRow = { Name: "Cohen Household", npo02__Formal_Greeting__c: "Ruth and Sam Cohen", npo02__Informal_Greeting__c: "Ruth and Sam", cs_Member__c: true };
const ruth: SfRow = { Id: CONTACT, Name: "Ruth Cohen", FirstName: "Ruth", Hebrew_Name__c: "רות", MobilePhone: "(314) 555-0101", AccountId: ACCOUNT, npsp__Deceased__c: false, Account: household };
vi.mock("@/server/salesforce", () => ({
  getSalesforce: (): SalesforceClient => ({
    async query(soql) {
      if (soql.includes("FROM Contact WHERE Account.cs_Member__c")) return [ruth];
      if (soql.includes("WHERE Id = '003000000000001")) return [ruth];
      return [];
    },
  }),
}));

import CareListPage from "@/app/care/page";
import { acceptProposalAction, captureAction, reportAction } from "@/app/inbox-actions";
import { setFollowUpDoneAction } from "@/app/care-actions";
import { findPeopleAction } from "@/app/find-actions";
import InboxPage from "@/app/inbox/page";
import TodayPage from "@/app/page";
import OutsideRoute from "@/app/people/outside/[outsideId]/page";
import PersonRoute from "@/app/people/[contactId]/page";
import ReportPage from "@/app/report/page";
import AdminPage from "@/app/settings/admin/page";
import SettingsPage from "@/app/settings/page";
import { settingsAndAdmin } from "./support/settings";
import FindPage from "@/app/find/page";
import UpcomingPage from "@/app/upcoming/page";
import { navItems } from "@/components/shell/app-shell";
import { TodayBody } from "@/components/today-body";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const search = <T,>(v: T) => Promise.resolve(v);
const redirects = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
const form = (values: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
};
const idle = { status: "idle" } as const;
const count = (s: string, needle: string) => s.split(needle).length - 1;

beforeAll(async () => {
  db = await testDb();
  state.db = db;
  process.env.OWNER_EMAILS = "owner@example.test";
  t = await team(db);
  r = await reporters(db);
});

describe("Inbox", () => {
  it("renders for clergy and the owner role with the words behind a disclosure, and is refused to every other role", async () => {
    await createProposal(db, r.staff, { rawText: "Ruth Cohen is in the hospital", channel: "staff" });
    await createProposal(db, t.clergy, { channel: "connector", reviewScope: "clergy", reading: { person: { contactId: CONTACT }, category: "illness", summary: "Admitted Tuesday", restrictedSuggested: true } });
    for (const who of [t.clergy2, t.owner]) {
      as(who);
      const out = await html(InboxPage({ searchParams: Promise.resolve({}) }));
      expect(count(out, 'data-testid="inbox-card"')).toBe(2);
      expect(out).toContain('data-testid="inbox-words"');
      expect(out).toContain('data-testid="inbox-reading"');
    }
    for (const who of [t.carer, r.staff, r.lead, r.senior]) {
      as(who);
      await redirects(InboxPage({ searchParams: Promise.resolve({}) }));
    }
  });

  it("an empty Inbox says what it is for", async () => {
    const empty = await testDb();
    const before = state.db;
    state.db = empty;
    const people = await team(empty);
    as(people.clergy);
    const out = await html(InboxPage({ searchParams: Promise.resolve({}) }));
    state.db = before;
    expect(out).toContain('data-testid="inbox-empty"');
  });

  it("a clergy member's own capture is in their Inbox and nobody else's", async () => {
    as(t.clergy);
    await captureAction(idle, form({ words: "Sam Levy lost his mother" }));
    expect(count(await html(InboxPage({ searchParams: Promise.resolve({}) })), 'data-testid="inbox-card"')).toBe(3);
    as(t.clergy2);
    expect(count(await html(InboxPage({ searchParams: Promise.resolve({}) })), 'data-testid="inbox-card"')).toBe(2);
  });
});

describe("quick capture, then the decision sheet", () => {
  it("capture makes a submitter-scope proposal; accepting it makes a care item with its fields, a restriction and a first follow-up", async () => {
    as(t.clergy);
    const captured = await captureAction(idle, form({ words: "Ruth Cohen fell and broke her hip" }));
    if (captured.status !== "ok") throw new Error("capture failed");
    const [p] = await db.select().from(proposals).where(eq(proposals.id, captured.data.id));
    expect(p).toMatchObject({ reviewScope: "submitter", status: "pending", channel: "capture", submittedBy: t.clergy.id });
    // Nobody else reviews it, and nothing is on the care list yet.
    expect(await listCareItems(db, t.clergy)).toEqual([]);

    const saved = await acceptProposalAction(
      idle,
      form({
        proposalId: captured.data.id,
        contactId: CONTACT,
        category: "illness",
        summary: "Broke her hip",
        location: "Barnes-Jewish, room 4",
        learnedFrom: "Her daughter",
        ownerUserId: t.clergy.id,
        restricted: "on",
        shows: "none",
        accessUserId: [t.clergy2.id],
        followUpTitle: "Call the family",
        followUpDue: "2026-12-01",
        followUpOwner: t.clergy.id,
      }),
    );
    expect(saved.status).toBe("ok");
    const [item] = await listCareItems(db, t.clergy, { sfContactId: CONTACT });
    expect(item).toMatchObject({ category: "illness", summary: "Broke her hip", location: "Barnes-Jewish, room 4", learnedFrom: "Her daughter", restricted: true, restrictedShowsCarer: false, status: "new", source: "capture" });
    expect(await db.select().from(followUps).where(eq(followUps.careItemId, item.id))).toHaveLength(1);
    // It was decided once: the words stay on the row for the rabbis (Daniel, 2026-11-25).
    const [after] = await db.select().from(proposals).where(eq(proposals.id, captured.data.id));
    expect(after).toMatchObject({ status: "accepted", reading: null });
    expect(after.rawText).toEqual(expect.any(String));
  });

  it("someone not in the directory is added by the decision itself, and 'Add to' an existing item writes a note on it", async () => {
    as(t.clergy);
    const first = await captureAction(idle, form({ words: "A member's mother in Denver is dying" }));
    if (first.status !== "ok") throw new Error("capture failed");
    const done = await acceptProposalAction(idle, form({ proposalId: first.data.id, newName: "Esther Katz", newPhone: "303 555 0100", newNote: "Mother of a member", category: "illness", summary: "Hospice" }));
    expect(done.status).toBe("ok");
    const [outside] = (await listCareItems(db, t.clergy, { status: "active" })).filter((i) => i.outsidePersonId);
    expect(outside.displayName).toBe("Esther Katz");

    const second = await captureAction(idle, form({ words: "Esther is now at home" }));
    if (second.status !== "ok") throw new Error("capture failed");
    const added = await acceptProposalAction(idle, form({ proposalId: second.data.id, outsidePersonId: outside.outsidePersonId!, careItemId: outside.id, summary: "Now at home" }));
    expect(added.status).toBe("ok");
    expect((await db.select().from(contactLog).where(eq(contactLog.careItemId, outside.id))).map((c) => c.note)).toEqual(["Now at home"]);
  });

  it("a bad decision is a calm message, not a crash, and leaves the words in place", async () => {
    as(t.clergy);
    const c = await captureAction(idle, form({ words: "Someone needs a call" }));
    if (c.status !== "ok") throw new Error("capture failed");
    expect((await acceptProposalAction(idle, form({ proposalId: c.data.id, category: "illness" }))).status).toBe("error");
    const [still] = await db.select().from(proposals).where(eq(proposals.id, c.data.id));
    expect(still.status).toBe("pending");
  });

  it("Today shows the capture box to clergy and the owner role, not to a caregiver", async () => {
    for (const who of [t.clergy, t.owner]) expect(await html(TodayBody({ actor: who }))).toContain('aria-label="Quick capture"');
    expect(await html(TodayBody({ actor: t.carer }))).not.toContain('aria-label="Quick capture"');
  });
});

describe("Report, and the roles that only report", () => {
  it("staff have Report, Mitzvah Meals and Settings in the menu and nothing else, and a lead also Volunteers; senior staff Report, Reports and Settings; a caregiver can reach Report", () => {
    expect(navItems(r.staff).map((i) => i.href)).toEqual(["/report", "/meals", "/settings"]);
    // A lead works from Volunteers: their home, Mitzvah Meals, the roster, the visiting list and Report.
    expect(navItems(r.lead).map((i) => i.href)).toEqual(["/volunteers", "/meals", "/volunteers/roster", "/volunteers/visiting", "/report", "/settings"]);
    expect(navItems(r.senior).map((i) => i.href)).toEqual(["/report", "/reports", "/settings"]);
    expect(navItems(t.carer).map((i) => i.href)).toContain("/report");
    expect(navItems(t.clergy).map((i) => i.href)).toContain("/inbox");
    expect(navItems(t.clergy).map((i) => i.href)).not.toContain("/report");
  });

  it("they are sent to Report from Today and every other page, and may open Report and Settings", async () => {
    for (const who of [r.staff, r.lead, r.senior]) {
      as(who);
      await redirects(TodayPage());
      await redirects(CareListPage({ searchParams: search({}) }));
      await redirects(FindPage({ searchParams: search({}) }));
      await redirects(UpcomingPage({ searchParams: search({}) }));
      await redirects(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) }));
      expect(await html(ReportPage())).toContain('id="report-words"');
      expect(await settingsAndAdmin()).toContain("Settings");
    }
  });

  it("staff and leads get the two 'add directly' forms with the rabbis' names; senior staff and caregivers only the report box", async () => {
    for (const who of [r.staff, r.lead]) {
      as(who);
      const out = await html(ReportPage());
      expect(out).toContain('name="ownerUserId"');
      expect(out).toContain('id="sm-name"');
      expect(out).toContain(`value="${t.clergy.id}"`);
      expect(out).not.toContain(t.clergy.email);
    }
    for (const who of [r.senior, t.carer]) {
      as(who);
      const out = await html(ReportPage());
      expect(out).not.toContain('name="ownerUserId"');
      expect(out).not.toContain('id="sm-name"');
    }
  });

  it("a report goes to the Inbox, and the reporter sees only a date and a status", async () => {
    as(r.staff);
    expect((await reportAction(idle, form({ words: "The Levys' son was in an accident" }))).status).toBe("ok");
    const out = await html(ReportPage());
    expect(count(out, 'data-testid="my-report"')).toBeGreaterThanOrEqual(1);
    expect(out).not.toContain("accident");
    // The reporter's list holds only their own.
    as(r.lead);
    expect(count(await html(ReportPage()), 'data-testid="my-report"')).toBe(0);
  });
});

describe("restricted items on the screens", () => {
  it("an unreadable restricted item is only 'In <name>'s care': no detail, no link", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "mental_health", summary: "SECRET-SUMMARY", location: "SECRET-WARD", restricted: true, restrictedShowsCarer: true });
    as(t.clergy2);
    const page = await html(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) }));
    const stub = page.split('data-testid="restricted-stub"')[1].split("</li>")[0];
    expect(stub).toContain("clergy");
    expect(stub).not.toContain("<a ");
    expect(page).not.toContain("SECRET");
    expect(page).not.toContain(item.id);
    const list = await html(CareListPage({ searchParams: search({ scope: "all" }) }));
    expect(list).toContain('data-testid="restricted-stub"');
    expect(list).not.toContain("SECRET");
    expect(list).not.toContain(item.id);
    // Its holder sees all of it, with the mark.
    as(t.clergy);
    const own = await html(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) }));
    expect(own).toContain("SECRET-SUMMARY");
    expect(own).toContain('data-testid="restricted-mark"');
  });
});

describe("people outside the directory", () => {
  it("Find returns them with Salesforce people, and their page has the same actions with no Salesforce data", async () => {
    as(t.clergy);
    const person = await createOutsidePerson(db, t.clergy, { name: "Cohen Outside", phone: "(303) 555-0100", note: "Lives in Denver" });
    const found = await findPeopleAction(idle, form({ q: "Cohen" }));
    expect(found).toMatchObject({ status: "results", outside: [{ id: person.id, name: "Cohen Outside" }], results: [{ contactId: CONTACT }] });
    const item = await createCareItem(db, t.clergy, { outsidePersonId: person.id, category: "ongoing", summary: "Check in monthly" });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call Denver", dueDate: "2026-12-05" });

    const out = await html(OutsideRoute({ params: search({ outsideId: person.id }), searchParams: search({}) }));
    expect(out).toContain("Cohen Outside");
    expect(out).toContain("Check in monthly");
    expect(out).toContain("Call Denver");
    expect(out).toContain('name="outsidePersonId"');
    expect(out).toContain("tel:+13035550100");
    expect(out).not.toContain('name="sfContactId"');
    expect(out).not.toContain('data-testid="person-date"');
    // The care list links to the right page.
    expect(await html(CareListPage({ searchParams: search({ scope: "all" }) }))).toContain(`/people/outside/${person.id}`);
    as(t.carer);
    await redirects(OutsideRoute({ params: search({ outsideId: person.id }), searchParams: search({}) }));
  });
});

describe("contacts and follow-ups", () => {
  it("'Done and log it' finishes the follow-up and writes the contact entry with its outcome", async () => {
    as(t.clergy);
    const item = await createCareItem(db, t.clergy, { sfContactId: ruth.Id as string, displayName: "Ruth Cohen", category: "birth" });
    const fu = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Bring a meal", dueDate: "2026-12-02" });
    expect((await setFollowUpDoneAction(idle, form({ followUpId: fu.id, outcome: "left_message" }))).status).toBe("ok");
    const [row] = await db.select().from(followUps).where(eq(followUps.id, fu.id));
    expect(row.doneAt).not.toBeNull();
    const entries = await db.select().from(contactLog).where(eq(contactLog.careItemId, item.id));
    expect(entries).toMatchObject([{ kind: "call", outcome: "left_message", authorUserId: t.clergy.id }]);
  });
});

describe("Settings: hand over", () => {
  it("is shown to the owner role only, only when there is something to hand over, and shows a count and a name, nothing else", async () => {
    const holder = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Zelda Unique", category: "other", summary: "HIDDEN-FROM-OWNER", restricted: true });
    void holder;
    as(t.owner);
    expect(await settingsAndAdmin()).not.toContain('data-testid="hand-over"');
    await updateUser(db, t.owner, t.clergy2.id, { active: false }, new Set(["owner@example.test"]));
    const out = await settingsAndAdmin();
    expect(count(out, 'data-testid="hand-over"')).toBe(1);
    expect(out).toContain("clergy2");
    expect(out).not.toContain("HIDDEN-FROM-OWNER");
    expect(out).not.toContain("Zelda");
    for (const who of [t.clergy, t.carer, r.staff]) {
      as(who);
      expect(await settingsAndAdmin()).not.toContain('data-testid="hand-over"');
    }
  });

  it("the role picker offers every assignable role", async () => {
    as(t.owner);
    const out = await settingsAndAdmin();
    const picker = out.split('id="team-role"')[1].split("</fieldset>")[0];
    for (const role of ["clergy", "caregiver", "staff", "lead", "senior_staff"]) expect(picker).toContain(`value="${role}"`);
  });
});

describe("Settings and Admin", () => {
  it("Admin is in the menu, linked from Settings and opens only for someone with a section on it; the menu says 'Report a need' and 'Numbers'", async () => {
    for (const who of [t.owner, t.clergy]) {
      as(who);
      expect(navItems(who).map((i) => i.href)).toContain("/settings/admin");
      expect(await html(SettingsPage())).toContain('data-testid="admin-link"');
      expect(await html(AdminPage())).toContain("Journeys");
    }
    for (const who of [t.carer, r.staff, r.lead, r.senior]) {
      as(who);
      expect(navItems(who).map((i) => i.href)).not.toContain("/settings/admin");
      expect(await html(SettingsPage())).not.toContain('data-testid="admin-link"');
      await redirects(AdminPage());
    }
    // People and roles is the owner's alone, on Admin and nowhere else.
    as(t.owner);
    expect(await html(AdminPage())).toContain('data-testid="team-member"');
    expect(await html(SettingsPage())).not.toContain('data-testid="team-member"');
    as(t.clergy);
    expect(await html(AdminPage())).not.toContain('data-testid="team-member"');
    expect(navItems(r.lead).map((i) => i.label)).toEqual(expect.arrayContaining(["Report a need"]));
    expect(navItems(r.senior).map((i) => i.label)).toEqual(expect.arrayContaining(["Report a need", "Numbers"]));
    expect(navItems(t.owner).map((i) => i.label)).not.toContain("Reports");
  });
});

describe("order on Today", () => {
  it("a rabbi's follow-ups come before quick capture and the side links", async () => {
    await createFollowUp(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", title: "Call Ruth", dueDate: "2026-01-01" });
    as(t.clergy);
    const out = await html(TodayBody({ actor: t.clergy }));
    const at = (needle: string) => out.indexOf(needle);
    expect(at('id="follow-ups"')).toBeGreaterThan(-1);
    expect(at('id="follow-ups"')).toBeLessThan(at('aria-label="Quick capture"'));
    expect(at('id="follow-ups"')).toBeLessThan(at('data-testid="today-visits-link"'));
  });
});
