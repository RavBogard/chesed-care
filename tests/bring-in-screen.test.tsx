import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createBatch } from "@/server/care/bring-in";
import { proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import type { SfRow } from "@/server/salesforce/client";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/server/salesforce", () => {
  const acct = { Name: "Cohen Household", cs_Member__c: true };
  const person = (Id: string, Name: string): SfRow => ({ Id, Name, FirstName: Name.split(" ")[0], Hebrew_Name__c: null, npsp__Deceased__c: false, AccountId: ACCOUNT, Account: acct });
  return {
    getSalesforce: () => ({
      query: async (soql: string): Promise<SfRow[]> => {
        if (/WHERE Id = '/.test(soql)) return [person(CONTACT, "Ruth Cohen")];
        const words = [...soql.matchAll(/Name LIKE '%([^%]+)%' OR/g)].map((m) => m[1].toLowerCase());
        return words.length && words.every((w) => "ruth cohen".includes(w)) ? [person(CONTACT, "Ruth Cohen")] : [];
      },
    }),
  };
});

import BringInPage from "@/app/inbox/bring-in/page";
import ReviewPage from "@/app/inbox/bring-in/review/page";
import InboxPage from "@/app/inbox/page";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const reviewPage = async (after?: string) => renderToStaticMarkup(await ReviewPage({ searchParams: Promise.resolve({ after }) }));

beforeAll(async () => {
  db = await testDb();
  state.db = db;
  t = await team(db);
  r = await reporters(db);
});

describe("the bring-in screens are for clergy and owner", () => {
  it("everyone else is sent away from both", async () => {
    for (const who of [t.carer, r.staff, r.lead, r.senior]) {
      as(who);
      await expect(BringInPage()).rejects.toThrow(/NEXT_REDIRECT/);
      await expect(ReviewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/NEXT_REDIRECT/);
    }
  });
  it("clergy and owner get the big text box, and the Inbox links to it", async () => {
    for (const who of [t.clergy, t.owner]) {
      as(who);
      const out = renderToStaticMarkup(await BringInPage());
      expect(out).toContain('id="bring-in-text"');
      const inbox = renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }));
      expect(inbox).toContain('data-testid="inbox-bring-in-link"');
      expect(inbox).toContain('data-testid="inbox-empty-bring-in"');
    }
  });
  it("a caregiver's Inbox is not offered it", async () => {
    as(t.carer);
    await expect(InboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe("the review screen", () => {
  it("shows one entry at a time with its place in the list, in the order listed", async () => {
    as(t.clergy);
    const { ids } = await createBatch(db, t.clergy, ["first entry words", "second entry words", "third entry words"]);
    let out = await reviewPage();
    expect(out).toContain("first entry words");
    expect(out).not.toContain("second entry words");
    expect(out).toMatch(/1 of 3/);
    out = await reviewPage("0");
    expect(out).toContain("second entry words");
    expect(out).toMatch(/2 of 3/);
    // After the last one it wraps to the first still waiting.
    expect(await reviewPage("2")).toContain("first entry words");
    // Another clergy member sees none of it.
    as(t.clergy2);
    expect(await reviewPage()).toContain('data-testid="bring-in-finished"');
    await db.delete(proposals).where(eq(proposals.id, ids[0]));
  });
  it("offers one tap only for a single strong match with a kind; otherwise the sheet", async () => {
    as(t.clergy);
    const { ids } = await createBatch(db, t.clergy, ["Ruth Cohen hip", "Zed Nobody knee"]);
    const reading = { by: "app_ai", names: ["Ruth Cohen"], summary: "Hip", category: "illness", restrictedSuggested: false };
    await db.update(proposals).set({ reading }).where(eq(proposals.id, ids[0]));
    await db.update(proposals).set({ reading: { ...reading, names: ["Zed Nobody"] } }).where(eq(proposals.id, ids[1]));
    const quick = await reviewPage("-1");
    expect(quick).toContain("data-review-primary");
    expect(quick).toContain("Yes, this is Ruth Cohen");
    expect(quick).toContain("The care team will be able to see this.");
    expect(quick).toContain("data-review-heading");
    expect(quick).toContain('data-testid="review-last-contact"');
    expect(quick).not.toContain("data-review-primary-wrap");
    const sheet = await reviewPage("0");
    expect(sheet).toContain("data-review-primary-wrap");
    expect(sheet).not.toMatch(/data-review-primary[ >]/);
    // A reading that looks sensitive is never one tap, and shows the hint.
    await db.update(proposals).set({ reading: { ...reading, restrictedSuggested: true } }).where(eq(proposals.id, ids[0]));
    const sensitive = await reviewPage("-1");
    expect(sensitive).toContain("data-review-primary-wrap");
    expect(sensitive).toContain("Looks sensitive");
  });
});
