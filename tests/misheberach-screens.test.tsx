import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { miSheberachEntries, miSheberachSync } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addEntry } from "@/server/misheberach/list";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/mi-sheberach" }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import MiSheberachPage from "@/app/mi-sheberach/page";
import NewMiSheberachPage from "@/app/mi-sheberach/new/page";
import ReadAloudPage from "@/app/mi-sheberach/read/page";
import { MiPrompts } from "@/components/misheberach/prompts";

const NOW = new Date("2026-11-24T18:00:00Z");
let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const redirects = (to: string) => ({ digest: expect.stringContaining(to) });
const HEBREW = "יעקב בן אברהם";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
afterEach(() => {
  for (const k of ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_SERVICE_ACCOUNT_KEY", "MISHEBERACH_DOC_ID", "MISHEBERACH_SYNC_MODE"]) delete process.env[k];
});
const connect = (mode?: string) => {
  process.env.MISHEBERACH_DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "care-sync@project.iam.example";
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "not-a-real-key";
  if (mode) process.env.MISHEBERACH_SYNC_MODE = mode;
  else delete process.env.MISHEBERACH_SYNC_MODE;
};
beforeEach(async () => {
  vi.setSystemTime(NOW);
  db = await testDb();
  state.db = db;
  t = { ...(await team(db)), ...(await reporters(db)) };
  as(t.clergy);
});

const add = (name: string, extra: Record<string, unknown> = {}) => addEntry(db, t.clergy, { name, ...extra }, { now: NOW }).then((x) => x.entry);

describe("the Mi Sheberach screens", () => {
  it("every role but owner and clergy gets a plain notice with no names on the list, the add form or the read-aloud view", async () => {
    await add("Ruth Cohen");
    for (const a of [t.carer, t.staff, t.lead, t.senior]) {
      as(a);
      for (const page of [MiSheberachPage(), NewMiSheberachPage({ searchParams: Promise.resolve({}) }), ReadAloudPage()]) {
        const out = await html(page as Promise<React.ReactElement>);
        expect(out).not.toContain("Ruth Cohen");
        expect(out).not.toContain('data-testid="mi-list"');
      }
    }
    state.viewer = { kind: "signed-out" };
    await expect(MiSheberachPage()).rejects.toMatchObject(redirects("/sign-in"));
  });

  it("the list shows each name as it will be read, marks the ones not yet confirmed and the ones about to come off, and has an Ended section", async () => {
    const soon = await add("Coming Off", { askedBy: "friend of Dana" });
    await db.update(miSheberachEntries).set({ dateAdded: "2026-08-01", consent: "confirmed" }).where(eq(miSheberachEntries.id, soon.id));
    await add("Fresh Name");
    const standing = await add("Standing Name", { kind: "standing" });
    await db.update(miSheberachEntries).set({ dateAdded: "2020-01-01" }).where(eq(miSheberachEntries.id, standing.id));
    const out = await html(MiSheberachPage());
    // Dated names newest first, then the standing ones.
    expect(out.indexOf("Fresh Name")).toBeLessThan(out.indexOf("Coming Off"));
    expect(out.indexOf("Coming Off")).toBeLessThan(out.indexOf("Standing Name"));
    expect(out.match(/data-testid="mi-unconfirmed"/g)).toHaveLength(2);
    expect(out.match(/data-testid="mi-expiring"/g)).toHaveLength(1);
    expect(out).toContain("friend of Dana");
    expect(out).toContain("Until further notice");
    expect(out).toContain('data-testid="mi-not-connected"');
  });

  it("says the packet is not connected, and shows the service account address to the owner only", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "care-sync@project.iam.example";
    expect(await html(MiSheberachPage())).not.toContain("care-sync@project.iam.example");
    as(t.owner);
    expect(await html(MiSheberachPage())).toContain("care-sync@project.iam.example");
  });

  it("a name linked to a restricted care item lists for clergy who cannot open it, with nothing of the item", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "mental_health", summary: "PRIVATE SUMMARY", restricted: true });
    await add("Ruth Cohen", { careItemId: item.id });
    as(t.clergy2);
    const out = await html(MiSheberachPage());
    expect(out).toContain("Ruth Cohen");
    expect(out).not.toContain(item.id);
    expect(out).not.toContain("PRIVATE SUMMARY");
    const read = await html(ReadAloudPage());
    expect(read).toContain("Ruth Cohen");
    expect(read).not.toContain(item.id);
  });

  it("the read-aloud view is the names alone, in order, each set to its own direction, and the controls are not printed", async () => {
    const older = await add("Fresh Name");
    await db.update(miSheberachEntries).set({ dateAdded: "2026-11-20" }).where(eq(miSheberachEntries.id, older.id));
    await add(HEBREW);
    const out = await html(ReadAloudPage());
    expect(out.match(/data-testid="mi-read-name"/g)).toHaveLength(2);
    expect(out.indexOf(HEBREW)).toBeLessThan(out.indexOf("Fresh Name"));
    expect(out).toContain('dir="auto"');
    expect(out).toContain('lang="he"');
    expect(out).toContain("print:hidden");
    expect(out).not.toMatch(/friend of|Until further notice|Edit/);
  });

  it("the add form can arrive from a care item, but only a clergy member who fully sees it gets the link", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "s", restricted: true });
    const q = (careItem: string) => NewMiSheberachPage({ searchParams: Promise.resolve({ careItem }) });
    const mine = await html(q(item.id));
    expect(mine).toContain('name="careItemId"');
    expect(mine).toContain("Ruth Cohen");
    as(t.clergy2);
    const theirs = await html(q(item.id));
    expect(theirs).not.toContain('name="careItemId"');
    expect(theirs).not.toContain("Ruth Cohen");
  });

  it("Today's prompt gives the three one-tap answers", () => {
    const out = renderToStaticMarkup(<MiPrompts prompts={[{ id: "11111111-1111-4111-8111-111111111111", name: "Coming Off", expiresOn: "2026-12-01" }]} />);
    expect(out).toContain('data-testid="mi-prompt"');
    for (const label of ["Keep 120 more days", "Until further notice", "Let it come off"]) expect(out).toContain(label);
    expect(renderToStaticMarkup(<MiPrompts prompts={[]} />)).toBe("");
  });

  it("in trial mode the page says so, shows what the sync would do, and offers the first-run import; after a stopped run it offers Apply anyway with the counts", async () => {
    connect();
    const plan = { addLines: ["Cal Dror (11/24/26)"], changeLines: [], removeLines: [], addEntries: ["Ann Roth"], endEntries: ["Ben Levi"], leftAlone: [{ text: "stray words", why: "unreadable" }] };
    await db.insert(miSheberachSync).values({ key: "packet", ok: true, plan, counts: { wouldAdd: 1 } });
    const out = await html(MiSheberachPage());
    expect(out).toContain('data-testid="mi-dry-run"');
    expect(out).toContain('data-testid="mi-plan"');
    for (const word of ["Cal Dror (11/24/26)", "Ann Roth", "Ben Levi", "stray words", "Not read as a name", "Import the current list"]) expect(out).toContain(word);
    expect(out).not.toContain("Apply anyway");
    await db.update(miSheberachSync).set({ ok: false, errorName: "PacketChangeTooLarge", counts: { wouldEnd: 4, wouldRemoveLines: 0, live: 6, lines: 6 } });
    const stopped = await html(MiSheberachPage());
    expect(stopped).toContain("Apply anyway");
    expect(stopped).toContain("4 names off the list");
    // Once synced it is no longer a first run, and "on" has no trial notice.
    await db.update(miSheberachSync).set({ ok: true, lastOkAt: NOW, snapshot: [] });
    connect("on");
    const on = await html(MiSheberachPage());
    expect(on).not.toContain('data-testid="mi-dry-run"');
    expect(on).not.toContain("Import the current list");
  });

  it("no plan, no import and no Apply anyway for anyone but owner and clergy, and nothing of it when the packet is not connected", async () => {
    connect();
    await db.insert(miSheberachSync).values({ key: "packet", ok: true, plan: { addLines: ["Secret Line (1/2/26)"], changeLines: [], removeLines: [], addEntries: [], endEntries: [], leftAlone: [] } });
    as(t.carer);
    expect(await html(MiSheberachPage())).not.toContain("Secret Line");
    as(t.clergy);
    delete process.env.MISHEBERACH_DOC_ID;
    const off = await html(MiSheberachPage());
    expect(off).toContain('data-testid="mi-not-connected"');
    expect(off).not.toContain("Secret Line");
  });

  it("a standing notice lists the lines the sync leaves alone by kind, the barred one first and loudest, with Remove it from the packet only on a real sync", async () => {
    connect("on");
    const plan = { addLines: [], changeLines: [], removeLines: [], addEntries: [], endEntries: [], leftAlone: [{ text: "stray words", why: "unreadable" }, { text: "Gil Amir (11/20/26)", why: "asked_not_listed" }, { text: "Ann Roth (11/10/26) other", why: "duplicate" }] };
    await db.insert(miSheberachSync).values({ key: "packet", ok: true, lastOkAt: NOW, snapshot: [], counts: { blocked: 1, leftAlone: 1, duplicates: 1 }, plan });
    const on = await html(MiSheberachPage());
    expect(on).toContain('data-testid="mi-left-alone-barred"');
    expect(on).toContain("This name is still in the packet and would be read aloud.");
    expect(on).toContain("Remove it from the packet");
    expect(on.indexOf("mi-left-alone-barred")).toBeLessThan(on.indexOf("mi-left-alone-unreadable"));
    for (const word of ["stray words", "Gil Amir (11/20/26)", "Ann Roth (11/10/26) other", "Same name as another entry"]) expect(on).toContain(word);
    // The plan view is for trial mode and stopped runs only.
    expect(on).not.toContain('data-testid="mi-plan"');
    connect();
    const dry = await html(MiSheberachPage());
    expect(dry).toContain('data-testid="mi-left-alone-barred"');
    expect(dry).not.toContain("Remove it from the packet");
    as(t.carer);
    expect(await html(MiSheberachPage())).not.toContain("Gil Amir");
  });

  it("says Last checked for a trial-mode run and Last synced only for a real one", async () => {
    connect();
    await db.insert(miSheberachSync).values({ key: "packet", ok: true, lastRunAt: NOW, counts: { dryRun: 1 }, plan: { addLines: [], changeLines: [], removeLines: [], addEntries: [], endEntries: [], leftAlone: [] } });
    const dry = await html(MiSheberachPage());
    expect(dry).toContain("Last checked");
    expect(dry).toContain("Not synced yet.");
    expect(dry).not.toContain("Last synced");
    await db.update(miSheberachSync).set({ lastOkAt: NOW, counts: { wrote: 0 } });
    connect("on");
    const on = await html(MiSheberachPage());
    expect(on).toContain("Last synced");
    expect(on).not.toContain("Last checked");
  });
});
