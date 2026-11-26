import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAgendaEntry } from "@/server/care/agenda";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { createOutsidePerson } from "@/server/care/outside-people";
import { agendaEntries, auditLog, contactLog } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday, addDays } from "@/server/lifecycle/window";
import { CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { words } from "./support/words";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/", redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import { addAgendaAction, discussAgendaAction } from "@/app/agenda-actions";
import { setAwayAction } from "@/app/away-actions";
import { searchNotesAction } from "@/app/find-actions";
import { updateOutsidePersonAction } from "@/app/outside-actions";
import { visitedAction } from "@/app/visits-actions";
import AgendaPage from "@/app/team/agenda/page";
import AgendaPrintPage from "@/app/team/agenda/print/page";
import VisitsPage from "@/app/today/visits/page";
import EditOutsidePersonPage from "@/app/people/outside/[outsideId]/edit/page";
import FindPage from "@/app/find/page";
import { TodayBody } from "@/components/today-body";
import { AwayLines, loadAwayLines } from "@/components/team/away-lines";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const as = (actor: unknown) => (state.viewer = { kind: "ok", actor });
const IDLE = { status: "idle" } as never;

beforeEach(async () => {
  process.env.OWNER_EMAILS = "owner@example.test";
  db = await testDb();
  state.db = db;
  t = await team(db);
  r = await reporters(db);
});

describe("agenda screens", () => {
  it("lists entries, and neither the screen nor the print view shows an entry on a restricted item to someone shut out", async () => {
    const hidden = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true });
    await addAgendaEntry(db, t.clergy, { careItemId: hidden.id, why: "Secret why" });
    await addAgendaEntry(db, t.clergy, { displayName: "Shared line" });
    as(t.clergy);
    const mine = renderToStaticMarkup(await AgendaPage());
    expect(mine).toContain("Hidden Hannah");
    expect((mine.match(/data-testid="agenda-entry"/g) ?? []).length).toBe(2);
    for (const actor of [t.clergy2, t.owner]) {
      as(actor);
      for (const page of [await AgendaPage(), await AgendaPrintPage()]) {
        const html = words(renderToStaticMarkup(page));
        expect(html).toContain("Shared line");
        expect(html).not.toMatch(/Hannah|Secret/);
        expect((html.match(/data-testid="agenda-(print-)?entry"/g) ?? []).length).toBe(1);
      }
    }
  });

  it("sends other roles away from it", async () => {
    for (const actor of [t.carer, r.staff]) {
      as(actor);
      await expect(AgendaPage()).rejects.toThrow(/redirect/);
    }
  });

  it("adds an entry and discusses it with a follow-up through the actions", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness" });
    as(t.clergy);
    expect(await addAgendaAction(IDLE, form({ careItemId: item.id, why: "Needs a visit" }))).toMatchObject({ status: "ok" });
    const [entry] = await db.select().from(agendaEntries);
    expect(await discussAgendaAction(IDLE, form({ entryId: entry.id, outcome: "ok", followUpOwner: t.clergy2.id }))).toMatchObject({ status: "ok" });
    expect((await db.select().from(agendaEntries))[0].discussedAt).not.toBeNull();
    as(t.carer);
    expect(await addAgendaAction(IDLE, form({ displayName: "no way" }))).toMatchObject({ status: "error" });
  });
});

describe("hospital screen", () => {
  it("lists places with a Maps link and a Visited button, which logs a visit", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ann A", category: "illness", location: "Barnes-Jewish" });
    as(t.clergy2);
    const html = renderToStaticMarkup(await VisitsPage());
    expect(html).toContain('data-testid="visit-plan"');
    expect(html).toContain("google.com/maps");
    expect(html).toContain('data-testid="visit-row"');
    expect(await visitedAction(IDLE, form({ careItemId: item.id }))).toMatchObject({ status: "ok" });
    expect(await db.select().from(contactLog)).toHaveLength(1);
    as(r.staff);
    await expect(VisitsPage()).rejects.toThrow(/redirect/);
  });
});

describe("away and cover on Today", () => {
  it("says who is away, and shows the coverer only follow-ups they can see", async () => {
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness" });
    const secret = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true });
    const todayKey = chicagoToday(new Date());
    const soon = addDays(todayKey, 1);
    await createFollowUp(db, t.clergy, { careItemId: plain.id, title: "Call Olivia", dueDate: soon });
    await createFollowUp(db, t.clergy, { careItemId: secret.id, title: "Secret call", dueDate: soon });
    as(t.clergy);
    const until = addDays(todayKey, 5);
    expect(await setAwayAction(IDLE, form({ userId: t.clergy.id, from: todayKey, until, coverUserId: t.clergy2.id }))).toMatchObject({ status: "ok" });
    const line = renderToStaticMarkup(AwayLines({ lines: await loadAwayLines(t.clergy2, todayKey) }));
    expect(line).toContain("is away until");
    expect(line).toContain("is covering");
    const today = words(renderToStaticMarkup(await TodayBody({ actor: t.clergy2 })));
    expect(today).toContain('data-testid="covering-section"');
    expect(today).toContain("Covering for clergy");
    expect(today).toContain("Call Olivia");
    expect(today).not.toMatch(/Secret|Hannah/);
    // A caregiver sees no away line at all.
    expect(await loadAwayLines(t.carer, todayKey)).toEqual([]);
    expect(await db.select().from(auditLog)).not.toHaveLength(0);
  });
});

describe("find in notes and the outside-person edit screen", () => {
  it("offers the notes mode to clergy only, and the action returns grouped hits", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness", summary: "Pneumonia" });
    expect(item.id).toBeTruthy();
    as(t.clergy);
    expect(renderToStaticMarkup(await FindPage({ searchParams: Promise.resolve({ mode: "notes" }) }))).toContain("find-notes-q");
    const out = await searchNotesAction({ status: "idle" }, form({ q: "pneumon" }));
    expect(out).toMatchObject({ status: "results", shown: 1 });
    expect(await searchNotesAction({ status: "idle" }, form({ q: "pn" }))).toMatchObject({ status: "error" });
    as(r.staff);
    expect(await searchNotesAction({ status: "idle" }, form({ q: "pneumon" }))).toMatchObject({ status: "error" });
  });

  it("edits an outside person and shows the address with its Maps link", async () => {
    const p = await createOutsidePerson(db, t.clergy, { name: "Pat Out", addressStreet: "1 Main St", addressCity: "Chicago", addressState: "IL" });
    as(t.clergy2);
    expect(renderToStaticMarkup(await EditOutsidePersonPage({ params: Promise.resolve({ outsideId: p.id }) }))).toContain("address-maps");
    expect(await updateOutsidePersonAction(IDLE, form({ outsidePersonId: p.id, name: "Pat Outside", addressStreet: "2 Oak St" }))).toMatchObject({ status: "ok" });
    as(t.carer);
    expect(await updateOutsidePersonAction(IDLE, form({ outsidePersonId: p.id, name: "No" }))).toMatchObject({ status: "error" });
  });
});
