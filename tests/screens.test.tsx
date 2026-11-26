import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp } from "@/server/care/follow-ups";
import type { Db } from "@/server/db/types";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { ACCOUNT, CONTACT, CONTACT2, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown, failSf: false }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));

const household: SfRow = { Name: "Cohen Household", npo02__Formal_Greeting__c: "Ruth and Sam Cohen", npo02__Informal_Greeting__c: "Ruth and Sam", cs_Member__c: true };
const ruth: SfRow = { Id: CONTACT, Name: "Ruth Cohen", FirstName: "Ruth", Hebrew_Name__c: "רות", MobilePhone: "(314) 555-0101", AccountId: ACCOUNT, npsp__Deceased__c: false, Account: household };
vi.mock("@/server/salesforce", () => ({
  getSalesforce: (): SalesforceClient => ({
    async query(soql) {
      if (state.failSf) throw new Error("down");
      if (soql.includes("FROM Contact WHERE Account.cs_Member__c")) return [ruth];
      if (soql.includes("WHERE Id = '003000000000001")) return [ruth];
      return [];
    },
  }),
}));

import CareListPage from "@/app/care/page";
import FindPage from "@/app/find/page";
import { findPeopleAction } from "@/app/find-actions";
import { users } from "@/server/db/schema";
import PersonRoute from "@/app/people/[contactId]/page";
import { settingsAndAdmin } from "./support/settings";
import UpcomingPage from "@/app/upcoming/page";
import { TodayBody } from "@/components/today-body";
import { navItems } from "@/components/shell/app-shell";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const search = <T,>(v: T) => Promise.resolve(v);

beforeAll(async () => {
  db = await testDb();
  state.db = db;
  process.env.OWNER_EMAILS = "owner@example.test";
  t = await team(db);
  const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", visibility: "caregivers", ownerUserId: t.carer.id });
  await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Bring soup", dueDate: "2020-01-01", ownerUserId: t.carer.id });
  await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", kind: "call", occurredAt: new Date(), note: "clergy-only words", private: true });
  await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", kind: "visit", occurredAt: new Date(), note: "shared clergy words" });
  // Another caregiver's item, and a follow-up for the caregiver on an item they cannot see.
  const other = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Levy", category: "other", visibility: "caregivers", ownerUserId: t.carer2.id });
  void other;
  const theirs = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", visibility: "caregivers", ownerUserId: t.carer2.id });
  await createFollowUp(db, t.clergy, { careItemId: theirs.id, title: "Hidden-item errand", dueDate: "2026-12-01", ownerUserId: t.carer.id });
  await db.insert(users).values({ email: "stale@example.test", name: "Stale", role: "owner", active: true });
});

describe("screens render for the right people", () => {
  it("Today: an overdue follow-up shows first for its owner, with a way to finish it", async () => {
    const out = await html(TodayBody({ actor: t.carer }));
    expect(out).toContain("Bring soup");
    expect(out).toContain("Overdue");
    expect(out).toContain('data-testid="follow-up-row"');
  });

  it("Today: a Salesforce failure is an inline message, not a crash", async () => {
    state.failSf = true;
    const out = await html(TodayBody({ actor: t.clergy }));
    state.failSf = false;
    expect(out).toContain("could not be loaded");
  });

  it("Upcoming: clergy see it; a caregiver is sent away and has no menu entry", async () => {
    as(t.clergy);
    const upcoming = await html(UpcomingPage({ searchParams: search({ days: "30" }) }));
    expect(upcoming).toContain("30 days");
    // The window switch is a filter, not a set of pages.
    const windowNav = upcoming.split('aria-label="How far ahead"')[1].split("</nav>")[0];
    expect(windowNav).toContain('aria-current="true"');
    expect(windowNav).not.toContain('aria-current="page"');
    as(t.carer);
    await expect(UpcomingPage({ searchParams: search({}) })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(navItems(t.carer).map((i) => i.href)).not.toContain("/upcoming");
    expect(navItems(t.clergy).map((i) => i.href)).toContain("/upcoming");
  });

  it("Care list: filtered by the query string", async () => {
    as(t.clergy);
    const open = await html(CareListPage({ searchParams: search({ scope: "all" }) }));
    expect(open).toContain('data-testid="care-row"');
    const closed = await html(CareListPage({ searchParams: search({ status: "closed" }) }));
    expect(closed).not.toContain('data-testid="care-row"');
  });

  it("Find: the page has a search form and no query string; caregivers are sent away", async () => {
    as(t.clergy);
    expect(await html(FindPage({ searchParams: search({}) }))).toContain('role="search"');
    as(t.carer);
    await expect(FindPage({ searchParams: search({}) })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });

  it("Find action: results by POST; refuses signed-out and caregivers; bad query and Salesforce failure are calm", async () => {
    const q = (v: string) => { const f = new FormData(); f.set("q", v); return f; };
    const idle = { status: "idle" } as const;
    state.viewer = { kind: "signed-out" };
    expect((await findPeopleAction(idle, q("Cohen"))).status).toBe("error");
    as(t.carer);
    expect((await findPeopleAction(idle, q("Cohen"))).status).toBe("error");
    as(t.clergy);
    expect(await findPeopleAction(idle, q("Cohen"))).toMatchObject({ status: "results", results: [{ contactId: CONTACT }] });
    expect((await findPeopleAction(idle, q("a"))).status).toBe("error");
    state.failSf = true;
    expect((await findPeopleAction(idle, q("Cohen"))).status).toBe("error");
    state.failSf = false;
  });

  it("Care list: a caregiver with scope=all still sees only their own items", async () => {
    as(t.carer);
    const out = await html(CareListPage({ searchParams: search({ scope: "all" }) }));
    expect(out).toContain("Ruth Cohen");
    expect(out).not.toContain("Sam Levy");
  });

  it("Person page: a 15-character Id redirects to the canonical Id", async () => {
    as(t.clergy);
    await expect(PersonRoute({ params: search({ contactId: "003000000000001" }), searchParams: search({}) })).rejects.toMatchObject({ digest: expect.stringContaining(`/people/${CONTACT}`) });
  });

  it("Person page: phones, and another clergy member's private note stays hidden", async () => {
    as(t.clergy2);
    const out = await html(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) }));
    expect(out).toContain("tel:+13145550101");
    expect(out).toContain("sms:+13145550101");
    expect(out).toContain("Contact on");
    expect(out).not.toContain("clergy-only words");
  });

  it("Person page: a caregiver sees their care item but no Salesforce data", async () => {
    as(t.carer);
    const out = await html(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) }));
    expect(out).toContain("Bring soup");
    // A follow-up of theirs on an item they cannot see is still listed, not lost.
    expect(out).toContain("Hidden-item errand");
    expect(out).not.toContain("tel:");
    expect(out).not.toContain("clergy-only words");
    expect(out).not.toContain("shared clergy words");
  });

  it("Settings: drafts for clergy; team management for the owner only", async () => {
    as(t.clergy);
    const clergy = await settingsAndAdmin();
    expect(clergy).toContain("My text drafts");
    expect(clergy).not.toContain("Add someone");
    as(t.owner);
    const owner = await settingsAndAdmin();
    expect(owner).toContain("Add someone");
    // Deactivate is offered for everyone except a current owner: the stale owner row gets it, the real owner does not.
    const rows = owner.split('data-testid="team-member"').slice(1);
    const row = (email: string) => rows.find((r) => r.includes(email))!;
    expect(row("stale@example.test")).toContain("Deactivate");
    expect(row("owner@example.test")).not.toContain("Deactivate");
    as(t.carer);
    const carer = await settingsAndAdmin();
    expect(carer).not.toContain("Add someone");
    expect(carer).not.toContain("My text drafts");
  });
});
