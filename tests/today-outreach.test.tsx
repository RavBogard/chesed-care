import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp, setFollowUpDone } from "@/server/care/follow-ups";
import { getOutreachSuggestions } from "@/server/care/suggestions";
import { careItems } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CONTACT, CONTACT2, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { TodayBody } from "@/components/today-body";
import { dismissSuggestionAction } from "@/app/today-actions";

const NOW = new Date("2026-12-01T18:00:00Z");
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
const html = async (el: Promise<React.ReactElement>) => renderToStaticMarkup(await el);

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  db = await testDb();
  state.db = db;
  t = await team(db);
  state.viewer = { kind: "ok", actor: t.clergy };
});

describe("Today for clergy", () => {
  it("counts the day with a finish line, and shows a quiet, dismissible 'You might reach out to'", async () => {
    const stale = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Stale Person", category: "illness" });
    await db.update(careItems).set({ createdAt: new Date("2026-10-01T12:00:00Z") }).where(eq(careItems.id, stale.id));
    const other = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Other Person", category: "ongoing" });
    const due = await createFollowUp(db, t.clergy, { careItemId: other.id, title: "Call back", dueDate: "2026-12-01" });
    const done = await createFollowUp(db, t.clergy, { careItemId: other.id, title: "Already done", dueDate: "2026-12-01" });
    await setFollowUpDone(db, t.clergy, done.id, true, { now: NOW });

    let page = await html(TodayBody({ actor: state.viewer.actor as never }));
    expect(page).toContain('data-testid="day-progress"');
    expect(page).toMatch(/2 things today(<!-- -->)?, (<!-- -->)?1(<!-- -->)? done/);
    expect(page).not.toContain('data-testid="day-finished"');
    expect(page).toContain("You might reach out to");
    expect(page).toContain("outreach-row");
    expect(page).not.toMatch(/risk|score/i);

    await setFollowUpDone(db, t.clergy, due.id, true, { now: NOW });
    page = await html(TodayBody({ actor: state.viewer.actor as never }));
    expect(page).toContain('data-testid="day-finished"');

    const [s] = await getOutreachSuggestions(db, t.clergy, NOW);
    const form = new FormData();
    form.set("kind", s.kind);
    form.set("subjectId", s.subjectId);
    expect(await dismissSuggestionAction({ status: "idle" } as never, form)).toMatchObject({ status: "ok" });
    expect(await html(TodayBody({ actor: state.viewer.actor as never }))).not.toContain("outreach-row");
  });

  it("offers a caregiver neither the list nor the count of anything but their own work", async () => {
    state.viewer = { kind: "ok", actor: t.carer };
    const page = await html(TodayBody({ actor: state.viewer.actor as never }));
    expect(page).not.toContain("You might reach out to");
  });
});
