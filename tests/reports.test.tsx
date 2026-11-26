import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { careItems, contactLog, followUps, miSheberachEntries, proposals, volunteerClaims, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { startJourney } from "@/server/journeys/journeys";
import { getReport, parsePeriod } from "@/server/reports/report";
import { grandTotal, hideSmallInGroup } from "@/server/reports/small-number";
import { CONTACT, reporters, team, testDb } from "./support/db";
import { livePage, NOW } from "./support/meals";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown, sf: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => { state.sf(); return { query: async () => [] }; } }));

import ReportsPage from "@/app/reports/page";
import TeamPage from "@/app/team/page";

const PERIOD = { from: "2026-10-01", to: "2026-12-01" };
const NAMES = Array.from({ length: 9 }, (_, i) => `Zelda Zimmerman ${i + 1}`);
const day = (iso: string) => new Date(`${iso}T18:00:00Z`);

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const as = (actor: unknown) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement>) => renderToStaticMarkup(await page);

beforeEach(async () => {
  db = await testDb();
  state.db = db;
  state.sf.mockClear();
  t = await team(db);
  r = await reporters(db);
});

/** Nine named people: six illness (three new, three older than 8 weeks), two ongoing, one restricted. */
async function fixture() {
  const mk = async (i: number, category: "illness" | "ongoing", ageDays: number, over: Record<string, unknown> = {}) => {
    const item = await createCareItem(db, t.clergy, { sfContactId: i === 0 ? CONTACT : `00300000000020${i}AAA`, displayName: NAMES[i], category, ...over });
    await db.update(careItems).set({ createdAt: new Date(NOW.getTime() - ageDays * 86_400_000) }).where(eq(careItems.id, item.id));
    return item;
  };
  const illness = [];
  for (let i = 0; i < 6; i++) illness.push(await mk(i, "illness", i < 3 ? 5 : 80));
  await mk(6, "ongoing", 10);
  await mk(7, "ongoing", 12);
  await mk(8, "illness", 20, { restricted: true, ownerUserId: t.clergy2.id });
  // Six reports from staff arrived in the period and became these items; each had a first contact one day later. Two more came by the form.
  for (const [i, item] of illness.entries()) {
    const arrived = day(`2026-11-${String(10 + i).padStart(2, "0")}`);
    await db.insert(proposals).values({ channel: "staff", reviewScope: "clergy", rawText: null, status: "accepted", resultCareItemId: item.id, createdAt: arrived });
    await db.insert(contactLog).values({ careItemId: item.id, sfContactId: item.sfContactId, displayName: item.displayName, kind: "call", occurredAt: new Date(arrived.getTime() + 86_400_000), authorUserId: t.clergy.id });
  }
  await db.insert(proposals).values([{ channel: "form", reviewScope: "clergy", createdAt: day("2026-11-20") }, { channel: "form", reviewScope: "clergy", createdAt: day("2026-11-21") }]);
  for (const item of illness) await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-20" }, day("2026-11-21"));
  const steps = await db.select().from(followUps).where(eq(followUps.journeyId, followUps.journeyId));
  await db.update(followUps).set({ dueDate: "2026-11-25" }).where(eq(followUps.journeyId, steps[0].journeyId!));
  // Volunteer tasks: five posted, two filled.
  const tasks = await db.insert(volunteerTasks).values(Array.from({ length: 5 }, (_, i) => ({ kind: "ride" as const, forLabel: "Ruth", needed: "A ride", taskDate: "2026-12-10", createdBy: t.clergy.id, createdAt: day(`2026-11-0${i + 1}`) }))).returning();
  for (const task of tasks.slice(0, 2)) await db.insert(volunteerClaims).values({ taskId: task.id, firstName: "Dana", contactKey: `k${task.id}`, manageTokenHash: `h${task.id}` });
  await livePage(db, t.clergy);
  // Mi Sheberach: six added in the period, five of them ended.
  await db.insert(miSheberachEntries).values(
    Array.from({ length: 6 }, (_, i) => ({ name: `Name ${i}`, nameKey: `name ${i}`, dateAdded: "2026-11-02", ...(i < 5 ? { endedAt: day("2026-11-25"), endedReason: "recovered" as const } : {}) })),
  );
}

describe("small numbers", () => {
  it("hides under 5, rounds the rest to 5, and hides a second cell or the total so a hidden one cannot be subtracted back", () => {
    expect(hideSmallInGroup([20, 10, 12])).toEqual({ cells: [20, 10, 10], total: 40 });
    // One hidden cell: the smallest other cell goes too, and the total stays.
    expect(hideSmallInGroup([20, 3, 12])).toEqual({ cells: [20, null, null], total: 35 });
    // Two hidden cells: the row total goes.
    expect(hideSmallInGroup([2, 3, 12])).toEqual({ cells: [null, null, 10], total: null });
    // An exact zero is a shown value, not a hidden cell.
    expect(hideSmallInGroup([0, 0, 12])).toEqual({ cells: [0, 0, 10], total: 10 });
    expect(hideSmallInGroup([0, 3, 12])).toEqual({ cells: [0, null, null], total: 15 });
    expect(hideSmallInGroup([2, 0, 12])).toEqual({ cells: [null, 0, null], total: 15 });
    expect(hideSmallInGroup([5, 1, 0])).toEqual({ cells: [null, null, 0], total: 5 });
    expect(hideSmallInGroup([2, 0, 0])).toEqual({ cells: [null, 0, 0], total: null });
    expect(grandTotal([10, 15], 25)).toBe(25);
    expect(grandTotal([20, null], 30)).toBeNull();
    expect(grandTotal([20, 10], 31)).toBe(30);
  });
  it("parses a free period for clergy, with a sensible fallback", () => {
    expect(parsePeriod({ from: "2026-10-01", to: "2026-12-01" }, NOW)).toEqual(PERIOD);
    expect(parsePeriod({ from: "nope" }, NOW)).toEqual({ from: "2026-09-02", to: "2026-12-01" });
    expect(parsePeriod({ from: "2020-01-01", to: "2026-12-01" }, NOW).from).toBe("2025-11-30");
  });
  it("snaps the no-names period to whole months or quarters, whatever is posted", () => {
    const whole = { whole: true };
    expect(parsePeriod({ from: "2026-10-09", to: "2026-10-20" }, NOW, whole)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(parsePeriod({ from: "2026-10-09", to: "2026-11-03" }, NOW, whole)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(parsePeriod({ period: "m:2026-02" }, NOW, whole)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(parsePeriod({ period: "q:2026-3" }, NOW, whole)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    // A long stretch is held to four quarters, ending where it ends.
    expect(parsePeriod({ from: "2020-01-01", to: "2026-12-01" }, NOW, whole)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(parsePeriod({}, NOW, whole)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });
});

describe("reports: numbers on a seeded fixture", () => {
  it("gives clergy the counts they fully see, exactly", async () => {
    await fixture();
    const rep = await getReport(db, t.clergy, PERIOD, NOW);
    expect(rep.nameless).toBe(false);
    expect(rep.openItems.rows).toEqual([
      { kind: "Illness", cells: [3, 0, 3], total: 6 },
      { kind: "Ongoing", cells: [2, 0, 0], total: 2 },
    ]);
    expect(rep.openItems.total).toBe(8);
    expect(rep.firstContact).toEqual({ medianDays: 1, count: 6 });
    expect(rep.channels).toEqual({ rows: expect.arrayContaining([{ channel: "staff", n: 6 }, { channel: "form", n: 2 }]), total: 8 });
    const planned = await db.select().from(followUps);
    expect(rep.journeys.planned).toBe(planned.filter((f) => f.journeyId && f.dueDate >= PERIOD.from && f.dueDate <= PERIOD.to).length);
    expect(rep.volunteers).toEqual({ posted: 5, filled: 2 });
    expect(rep.meals).toEqual({ offered: 1, covered: 0 });
    expect(rep.miSheberach).toEqual({ added: 6, ended: 5 });
  });

  it("counts the holder's restricted item for them and for no one else", async () => {
    await fixture();
    const holder = await getReport(db, t.clergy2, PERIOD, NOW);
    expect(holder.openItems.total).toBe(9);
    expect(holder.openItems.rows.find((x) => x.kind === "Illness")!.total).toBe(7);
  });

  it("is for clergy level and senior staff only", async () => {
    for (const a of [t.carer, r.staff, r.lead]) await expect(getReport(db, a, PERIOD, NOW)).rejects.toBeInstanceOf(AccessDenied);
    await expect(getReport(db, r.senior, PERIOD, NOW)).resolves.toMatchObject({ nameless: true });
  });
});

describe("reports: the senior staff version", () => {
  it("withholds every cell under 5, rounds the rest to 5, and hides what a total would give back", async () => {
    await fixture();
    const rep = await getReport(db, r.senior, PERIOD, NOW);
    expect(rep.nameless).toBe(true);
    // Illness has 6 non-restricted items in bands 3, 0 and 3: the two small cells are hidden and so is the row total; the exact zero is shown. Ongoing (2) is folded into "All other kinds".
    expect(rep.openItems.rows).toEqual([
      { kind: "Illness", cells: [null, 0, null], total: null },
      { kind: "All other kinds", cells: [null, 0, 0], total: null },
    ]);
    expect(rep.openItems.total).toBeNull();
    expect(rep.firstContact).toEqual({ medianDays: 1, count: 5 });
    expect(rep.volunteers).toEqual({ posted: 5, filled: null });
    expect(rep.meals).toEqual({ offered: null, covered: null });
    expect(rep.miSheberach).toEqual({ added: 5, ended: 5 });
    // Two form reports are hidden, and so is the other cell; the total (8) is shown rounded.
    expect(rep.channels.rows.map((x) => x.n)).toEqual([null, null]);
    expect(rep.channels.total).toBe(10);
  });

  it("is computed over non-restricted items only, so adding or removing a restricted item changes nothing", async () => {
    await fixture();
    const before = await getReport(db, r.senior, PERIOD, NOW);
    for (let i = 0; i < 7; i++) await createCareItem(db, t.clergy2, { sfContactId: `00300000000030${i}AAA`, displayName: `Hidden ${i}`, category: "illness", restricted: true });
    expect(await getReport(db, r.senior, PERIOD, NOW)).toEqual(before);
    await db.delete(careItems).where(eq(careItems.restricted, true)).catch(() => undefined);
    // A proposal that later became a restricted item still counts in its channel, by its own arrival.
    const [secret] = await db.select().from(careItems).where(eq(careItems.restricted, true));
    const [one] = await db.select().from(proposals).where(eq(proposals.channel, "staff"));
    if (secret) await db.update(proposals).set({ resultCareItemId: secret.id }).where(eq(proposals.id, one.id));
    expect((await getReport(db, r.senior, PERIOD, NOW)).channels).toEqual(before.channels);
  });

  it("does not move when one more item lands in a small cell", async () => {
    await fixture();
    const before = await getReport(db, r.senior, PERIOD, NOW);
    await createCareItem(db, t.clergy, { sfContactId: "003000000000400AAA", displayName: "Another Ongoing", category: "ongoing" });
    expect(await getReport(db, r.senior, PERIOD, NOW)).toEqual(before);
  });

  it("renders with no name anywhere, and says why a count is missing", async () => {
    await fixture();
    as(r.senior);
    const page = await html(ReportsPage({ searchParams: Promise.resolve(PERIOD) }));
    for (const name of [...NAMES, "Ruth", "Cohen", "Dana", "Hidden"]) expect(page).not.toContain(name);
    expect(page).toContain("fewer than 5");
    expect(page).toContain("report-open-items");
  });

  it("is hidden from a caregiver", async () => {
    as(t.carer);
    await expect(ReportsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/redirect/);
  });
});

describe("the team view and reports touch no Salesforce", () => {
  it("renders /team and /reports for clergy without a single Salesforce call", async () => {
    await fixture();
    as(t.clergy);
    const team1 = await html(TeamPage());
    const reports = await html(ReportsPage({ searchParams: Promise.resolve(PERIOD) }));
    expect(team1).toContain("team-person");
    expect(team1).toContain("May hold restricted items not shown.");
    expect(reports).toContain("report-open-items");
    expect(state.sf).not.toHaveBeenCalled();
  });
});
