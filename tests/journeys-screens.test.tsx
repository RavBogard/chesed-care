import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem, getCareItem } from "@/server/care/care-items";
import { listFollowUps, listLeadSteps } from "@/server/care/follow-ups";
import { createProposal } from "@/server/care/proposals";
import { careItems, dailySummaries, followUps, jobRuns, journeyTemplates, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { DAILY_TASKS, runDailyJob } from "@/server/daily/run";
import { listJourneyChoices, listJourneys, startJourney } from "@/server/journeys/journeys";
import { CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import * as journeyActions from "@/app/journey-actions";
import { completeLeadStepAction, saveJourneyTemplateAction, setSummaryPrefAction, startJourneyAction } from "@/app/journey-actions";
import { acceptProposalAction } from "@/app/inbox-actions";
import ReportPage from "@/app/report/page";
import { settingsAndAdmin } from "./support/settings";
import { MorningStrip } from "@/components/morning-strip";
import { PersonCare, type CareView } from "@/components/person-care";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const count = (s: string, needle: string) => s.split(needle).length - 1;
const formData = (values: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
};
const IDLE = { status: "idle" } as const;

beforeEach(async () => {
  db = await testDb();
  state.db = db;
  t = await team(db);
  r = await reporters(db);
});

describe("starting a journey from the screens", () => {
  it("starts with only the ticked steps, refuses a second start, and shows on the care item with End", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    as(t.clergy);
    const start = { careItemId: item.id, journeyKey: "illness", journeyAnchor: "2026-11-25", journeyPreviewed: "yes", journeyStep: ["visit_or_call", "close_or_continue"] };
    expect(await startJourneyAction(IDLE, formData(start))).toMatchObject({ status: "ok" });
    expect((await listFollowUps(db, t.clergy, { careItemId: item.id })).map((f) => f.title)).toHaveLength(2);
    expect(await startJourneyAction(IDLE, formData(start))).toMatchObject({ status: "error" });
    as(t.carer);
    expect(await startJourneyAction(IDLE, formData({ ...start, journeyKey: "standing" }))).toMatchObject({ status: "error" });

    const view: CareView = {
      today: "2026-11-25",
      name: "Ruth Cohen",
      careItems: [await getCareItem(db, t.clergy, item.id)],
      restrictedCare: [],
      followUps: await listFollowUps(db, t.clergy, { careItemId: item.id }),
      contacts: [],
      team: [],
      access: {},
      journeys: await listJourneys(db, t.clergy, [item.id]),
      journeyChoices: await listJourneyChoices(db, t.clergy),
    };
    const page = await html(<PersonCare view={view} actor={t.clergy} />);
    expect(count(page, 'data-testid="care-journey"')).toBe(1);
    expect(page).toContain("Start a journey");
    // A caregiver's view of the same item has no journey controls at all.
    const carerPage = await html(<PersonCare view={{ ...view, journeys: [], journeyChoices: undefined }} actor={t.carer} />);
    expect(carerPage).not.toContain("Start a journey");
  });

  it("accepting a Salesforce death starts the bereavement year with the ticked steps", async () => {
    const p = await createProposal(db, t.clergy, { rawText: "Start the bereavement year for the Cohen household?", channel: "capture" });
    as(t.clergy);
    const res = await acceptProposalAction(
      IDLE,
      formData({ proposalId: p.id, newName: "Ruth Cohen", category: "bereavement", journeyKey: "bereavement_year", journeyAnchor: "2026-11-24", journeyPreviewed: "yes", journeyStep: ["shiva_visit", "arrange_meals"], journeyLead: "" }),
    );
    expect(res).toMatchObject({ status: "ok" });
    const made = await db.select().from(followUps);
    expect(made.map((f) => [f.title, f.ownerUserId, f.forLead]).sort()).toEqual(
      [
        ["Arrange meals", t.clergy.id, true],
        ["Shiva visit", t.clergy.id, false],
      ].sort(),
    );
  });
});

describe("Mitzvah Corps lead screens", () => {
  it("the Report page lists a lead's own steps, nothing of the care, and Done takes a one-line outcome", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement", summary: "Lost her husband to cancer" });
    await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: "2026-11-24" }, new Date("2026-11-24T18:00:00Z"));
    const restricted = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Secret", category: "mental_health", restricted: true });
    await startJourney(db, t.clergy, restricted.id, { templateKey: "bereavement_year", anchorDate: "2026-11-24" }, new Date("2026-11-24T18:00:00Z"));
    as(r.lead);
    const page = await html(ReportPage());
    expect(count(page, 'data-testid="lead-step"')).toBe(4);
    expect(page).toContain("Ruth Cohen");
    // The lead's own 'add to a care list' form offers every kind of care as a choice; that list of choices is not about anyone.
    expect(page.replace(/<select id="sa-category"[\s\S]*?<\/select>/, "")).not.toMatch(/Sam Secret|cancer|Bereavement|mental/i);
    expect(page).toContain(`/meals/new?contact=${CONTACT}`);

    const [step] = await listLeadSteps(db, r.lead);
    expect(await completeLeadStepAction(IDLE, formData({ followUpId: step.id, outcome: "Meals set for two weeks" }))).toMatchObject({ status: "ok" });
    as(r.staff);
    expect(await completeLeadStepAction(IDLE, formData({ followUpId: step.id, outcome: "x" }))).toMatchObject({ status: "error" });
    const staffPage = await html(ReportPage());
    expect(staffPage).not.toContain('data-testid="lead-step"');
  });

  it("the morning strip shows the counts with links, and nothing on an empty day", async () => {
    const strip = await html(<MorningStrip summary={{ overdue: 2, dueToday: 0, inbox: 1, newSteps: 3 }} />);
    expect(["morning-overdue", "morning-inbox", "morning-steps"].every((id) => strip.includes(`data-testid="${id}"`))).toBe(true);
    expect(strip).not.toContain('data-testid="morning-today"');
    expect(strip).toContain('href="/inbox"');
    expect(await html(<MorningStrip summary={{ overdue: 0, dueToday: 0, inbox: 0, newSteps: 0 }} />)).toBe("");
  });

  it("after the daily job a lead's Report page carries their strip", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement" });
    await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: "2026-11-20" }, new Date());
    await runDailyJob({ db, now: new Date(), owners: new Set(["owner@example.test"]), origin: null });
    expect((await db.select().from(dailySummaries).where(eq(dailySummaries.userId, r.lead.id))).length).toBe(1);
    as(r.lead);
    expect(await html(ReportPage())).toContain('data-testid="morning-strip"');
  });
});

describe("Settings: journeys, the morning summary, the daily job", () => {
  it("templates for owner and clergy, the daily job for the owner only, the summary choice for everyone", async () => {
    as(t.owner);
    const owner = await settingsAndAdmin();
    expect(count(owner, 'data-testid="journey-template"')).toBe(4);
    expect(owner).toContain('data-testid="summary-pref"');
    expect(owner).toContain('data-testid="job-never"');
    expect(owner).toContain('data-testid="job-overdue"');
    await runDailyJob({ db, now: new Date(), owners: new Set(["owner@example.test"]), origin: null });
    const after = await settingsAndAdmin();
    expect(count(after, 'data-testid="job-run"')).toBe(DAILY_TASKS.length);
    expect(after).not.toContain("job-overdue");
    // A schedule that stopped: the last successful run is more than 26 hours old.
    const old = new Date(Date.now() - 27 * 3_600_000);
    await db.update(jobRuns).set({ startedAt: old, finishedAt: old });
    expect(await settingsAndAdmin()).toContain('data-testid="job-overdue"');

    as(t.clergy);
    const clergy = await settingsAndAdmin();
    expect(count(clergy, 'data-testid="journey-template"')).toBe(4);
    expect(clergy).not.toMatch(/job-run|job-never/);
    for (const a of [t.carer, r.lead, r.staff]) {
      as(a);
      const page = await settingsAndAdmin();
      expect(page).not.toContain('data-testid="journey-template"');
      expect(page).toContain('data-testid="summary-pref"');
    }
  });

  it("saving a template edits titles and offsets, removes and adds steps; reset restores it; a caregiver is refused", async () => {
    as(t.clergy);
    const save = formData({
      templateKey: "new_baby",
      stepCount: "4",
      intent: "save",
      step_0_id: "mazal_tov_call",
      step_0_title: "Call with a mazal tov",
      step_0_rule: "days",
      step_0_amount: "1",
      step_0_who: "clergy",
      step_1_id: "ask_naming_bris",
      step_1_title: "x",
      step_1_rule: "days",
      step_1_amount: "3",
      step_1_who: "clergy",
      step_1_remove: "on",
      step_2_id: "meals_for_parents",
      step_2_title: "Arrange meals for the parents",
      step_2_rule: "days",
      step_2_amount: "0",
      step_2_who: "lead",
      step_2_link: "meals",
      step_3_id: "check_in_month_3",
      step_3_title: "Check in, three months on",
      step_3_rule: "months",
      step_3_amount: "3",
      step_3_who: "clergy",
      new_title: "Send a card",
      new_rule: "days",
      new_amount: "7",
      new_who: "clergy",
    });
    expect(await saveJourneyTemplateAction(IDLE, save)).toMatchObject({ status: "ok" });
    const [row] = await db.select().from(journeyTemplates).where(eq(journeyTemplates.key, "new_baby"));
    expect((row.steps as { id: string; title: string }[]).map((s) => [s.id, s.title])).toEqual([
      ["mazal_tov_call", "Call with a mazal tov"],
      ["meals_for_parents", "Arrange meals for the parents"],
      ["check_in_month_3", "Check in, three months on"],
      ["step_1", "Send a card"],
    ]);
    as(t.carer);
    expect(await saveJourneyTemplateAction(IDLE, formData({ templateKey: "new_baby", intent: "reset" }))).toMatchObject({ status: "error" });
    as(t.owner);
    expect(await saveJourneyTemplateAction(IDLE, formData({ templateKey: "new_baby", intent: "reset" }))).toMatchObject({ status: "ok" });
    const [reset] = await db.select().from(journeyTemplates).where(eq(journeyTemplates.key, "new_baby"));
    expect((reset.steps as unknown[]).length).toBe(4);
  });

  it("each person saves their own summary choice; a closed item offers no keep-notes switch and says nothing of deleting notes", async () => {
    as(r.staff);
    expect(await setSummaryPrefAction(IDLE, formData({ summaryPref: "push" }))).toMatchObject({ status: "ok" });
    expect((await db.select().from(users).where(eq(users.id, r.staff.id)))[0].summaryPref).toBe("push");
    expect(await setSummaryPrefAction(IDLE, formData({ summaryPref: "text" }))).toMatchObject({ status: "error" });

    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    await db.update(careItems).set({ status: "closed", closedAt: new Date("2026-01-01T12:00:00Z") }).where(eq(careItems.id, item.id));
    // The switch is gone with the three-year purge it switched off (Daniel, 2026-11-25): no action, no control, no wording.
    expect(Object.keys(journeyActions)).not.toContain("setKeepNotesAction");
    // Whatever the old columns hold: a closed item, one once marked keep, one un-kept, one the old purge cleared.
    for (const old of [{ keepNotes: false }, { keepNotes: true }, { notesUnkeptAt: new Date("2026-02-01T12:00:00Z") }, { notesPurgedAt: new Date("2026-03-01T12:00:00Z") }]) {
      await db.update(careItems).set(old).where(eq(careItems.id, item.id));
      const closed = await getCareItem(db, t.clergy, item.id);
      const view = { today: "2026-11-25", name: "Ruth Cohen", careItems: [closed], restrictedCare: [], followUps: [], contacts: [], team: [], access: {} };
      const page = await html(<PersonCare view={view} actor={t.clergy} />);
      expect(page).toContain('data-testid="closed-item"');
      expect(page).not.toContain("notes-retention");
      expect(page).not.toMatch(/delet|Keep these notes|Stop keeping|three years|Notes kept/i);
    }
  });
});
