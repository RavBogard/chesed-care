import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { careItems, followUps, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CONTACT, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { settingsAndAdmin } from "./support/settings";
import { handOverWorkAction } from "@/app/settings-actions";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};

beforeEach(async () => {
  process.env.OWNER_EMAILS = "owner@example.test";
  db = await testDb();
  state.db = db;
  t = await team(db);
  state.viewer = { kind: "ok", actor: t.owner };
});

describe("deactivating someone who holds work", () => {
  it("offers the hand-over sheet only to those who hold work, hands it over, then deactivates", async () => {
    const item = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    await createFollowUp(db, t.clergy2, { careItemId: item.id, title: "Call", dueDate: "2026-12-03" });
    const page = await settingsAndAdmin();
    expect(page).toContain("Hand over their work");
    expect(page).toContain("handover-items");
    // One sheet: clergy2 holds work, clergy does not.
    expect(page.split("Hand over their work").length - 1).toBeLessThanOrEqual(2);

    const out = await handOverWorkAction({ status: "idle" } as never, form({ userId: t.clergy2.id, itemsTo: t.clergy.id, followUpsTo: t.clergy.id }));
    expect(out).toMatchObject({ status: "ok" });
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0].ownerUserId).toBe(t.clergy.id);
    expect((await db.select().from(followUps))[0].ownerUserId).toBe(t.clergy.id);
    expect((await db.select().from(users).where(eq(users.id, t.clergy2.id)))[0].active).toBe(false);
  });

  it("never moves work from someone on the owner allowlist, and leaves them out of the choices", async () => {
    const item = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    process.env.OWNER_EMAILS = "owner@example.test,clergy2@example.test";
    expect(await handOverWorkAction({ status: "idle" } as never, form({ userId: t.clergy2.id, itemsTo: t.clergy.id }))).toMatchObject({ status: "error" });
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0].ownerUserId).toBe(t.clergy2.id);
    process.env.OWNER_EMAILS = "owner@example.test";
    const page = await settingsAndAdmin();
    const sheet = page.slice(page.indexOf("handover-items"));
    expect(sheet.slice(0, sheet.indexOf("</select>"))).not.toContain(">clergy2<");
  });

  it("refuses anyone but the owner, and an incomplete plan changes nothing", async () => {
    const item = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    state.viewer = { kind: "ok", actor: t.clergy };
    expect(await handOverWorkAction({ status: "idle" } as never, form({ userId: t.clergy2.id, itemsTo: t.clergy.id }))).toMatchObject({ status: "error" });
    state.viewer = { kind: "ok", actor: t.owner };
    expect(await handOverWorkAction({ status: "idle" } as never, form({ userId: t.clergy2.id }))).toMatchObject({ status: "error" });
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0].ownerUserId).toBe(t.clergy2.id);
    expect((await db.select().from(users).where(eq(users.id, t.clergy2.id)))[0].active).toBe(true);
  });
});
