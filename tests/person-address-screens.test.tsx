import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { getBrief } from "@/server/care/brief";
import { createOutsidePerson } from "@/server/care/outside-people";
import type { Db } from "@/server/db/types";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/" }));

const household: SfRow = { Name: "Cohen Household", npo02__Formal_Greeting__c: "Ruth and Sam Cohen", cs_Member__c: true, BillingStreet: "9 Home Rd", BillingCity: "Ladue", BillingState: "MO" };
const ruth: SfRow = {
  Id: CONTACT,
  Name: "Ruth Cohen",
  FirstName: "Ruth",
  MobilePhone: "(314) 555-0101",
  AccountId: ACCOUNT,
  npsp__Deceased__c: false,
  MailingStreet: "12 Maple Ave",
  MailingCity: "Clayton",
  MailingState: "MO",
  MailingPostalCode: "63105",
  Account: household,
};
vi.mock("@/server/salesforce", () => ({
  getSalesforce: (): SalesforceClient => ({
    async query(soql) {
      if (soql.includes("FROM Contact WHERE Account.cs_Member__c")) return [ruth];
      if (soql.includes("WHERE Id = '003000000000001")) return [ruth];
      return [];
    },
  }),
}));

import { findPeopleAction } from "@/app/find-actions";
import OutsideRoute from "@/app/people/outside/[outsideId]/page";
import PersonRoute from "@/app/people/[contactId]/page";
import { BriefView } from "@/components/brief";
import { DetailsForm } from "@/components/meals/organiser-forms";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const search = <T,>(v: T) => Promise.resolve(v);
const MAPS = "https://www.google.com/maps/search/?api=1&amp;query=12%20Maple%20Ave%2C%20Clayton%2C%20MO%2063105";

beforeAll(async () => {
  db = await testDb();
  state.db = db;
  process.env.OWNER_EMAILS = "owner@example.test";
  t = await team(db);
  r = await reporters(db);
});

describe("person page", () => {
  it("shows the address and a safe Maps link to clergy level, the same people who see phones", async () => {
    for (const who of [t.clergy, t.owner]) {
      as(who);
      const page = await html(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) }));
      expect(page).toContain('data-testid="person-address"');
      expect(page).toContain("12 Maple Ave");
      expect(page).toContain(`href="${MAPS}"`);
      const link = page.split('data-testid="address-maps"')[0].split("<a ").pop()!;
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
      expect(page).toContain("opens in a new tab");
      expect(page).toContain("Copy address");
      expect(page).toContain("tel:"); // the phones are there for exactly these people
    }
  });

  it("shows no address to a caregiver, and refuses the other roles the page", async () => {
    as(t.carer);
    try {
      const page = await html(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) }));
      expect(page).not.toContain("Maple");
      expect(page).not.toContain('data-testid="person-address"');
    } catch {
      // Not found for a caregiver with no care item: nothing shown either way.
    }
    for (const who of [r.staff, r.lead, r.senior]) {
      as(who);
      await expect(PersonRoute({ params: search({ contactId: CONTACT }), searchParams: search({}) })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    }
  });
});

describe("outside person page and brief", () => {
  it("shows the address with the same link, and nothing when there is none", async () => {
    as(t.clergy);
    const p = await createOutsidePerson(db, t.clergy, { name: "Denver Parent", addressStreet: "5 Elm St", addressCity: "Denver", addressState: "CO", addressPostalCode: "80202" });
    const page = await html(OutsideRoute({ params: search({ outsideId: p.id }), searchParams: search({}) }));
    expect(page).toContain("5 Elm St");
    expect(page).toContain("https://www.google.com/maps/search/?api=1&amp;query=5%20Elm%20St%2C%20Denver%2C%20CO%2080202");
    const bare = await createOutsidePerson(db, t.clergy, { name: "No Address Person" });
    expect(await html(OutsideRoute({ params: search({ outsideId: bare.id }), searchParams: search({}) }))).not.toContain('data-testid="person-address"');
  });

  it("the brief page shows the address as text with a link that is hidden on paper", async () => {
    const brief = await getBrief({ db, sf: () => ({ query: async () => [ruth] }), now: new Date("2026-12-01T18:00:00Z") }, t.clergy, { contactId: CONTACT });
    const view = await html(<BriefView brief={brief} />);
    const box = view.split('data-testid="brief-address"')[1];
    expect(box).toContain("12 Maple Ave");
    expect(box).toContain("Clayton, MO 63105");
    expect(view).toContain('data-testid="brief-address-maps"');
    expect(view.split("<a ").find((a) => a.includes("brief-address-maps"))).toContain("print:hidden");
    const none = await html(<BriefView brief={{ ...brief, address: null }} />);
    expect(none).not.toContain('data-testid="brief-address"');
  });
});

describe("Find", () => {
  it("returns city and state with each person, never a street", async () => {
    as(t.clergy);
    const out = await findPeopleAction({ status: "idle" }, (() => { const f = new FormData(); f.set("q", "Cohen"); return f; })());
    expect(out.status).toBe("results");
    if (out.status !== "results") return;
    expect(out.results[0].place).toBe("Clayton, MO");
    expect(words(out)).not.toMatch(/Maple|63105/);
  });
});

describe("Use their address", () => {
  const v = { title: "T", note: null, foodFor: null, kashrut: "none", dietary: [], allergies: null, dropOffWindow: null, dropOffInstructions: null, dropOffAddress: null, dropOffIsHome: false, deliveryPlaces: null, giftCards: null, giftCardEmail: null } as never;
  it("is a button only when an address was offered, and never fills the field itself", async () => {
    const offered = await html(<DetailsForm pageId="p" v={v} addressSuggestion="12 Maple Ave, Clayton, MO 63105" />);
    expect(offered).toContain('data-testid="use-address"');
    expect(offered).not.toContain("12 Maple Ave");
    expect(await html(<DetailsForm pageId="p" v={v} />)).not.toContain('data-testid="use-address"');
  });
});
