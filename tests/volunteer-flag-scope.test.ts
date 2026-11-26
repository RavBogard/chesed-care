import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/server/access/policy";
import { initialFor, type InboxEntry } from "@/components/inbox-card";
import { createCareItem } from "@/server/care/care-items";
import { countClosedReports, listClosedReports, reopenProposal } from "@/server/care/closed-reports";
import { getOriginalReports } from "@/server/care/original-reports";
import { acceptProposal, createProposal, dismissProposal, listInbox } from "@/server/care/proposals";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { proposals, volunteerClaims } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { TOOLS } from "@/server/mcp/tools";
import { callTool } from "@/server/mcp/transport";
import { flagForRabbis } from "@/server/volunteers/flag";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { claimTask } from "@/server/volunteers/public";
import { ACCOUNT, CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { meta, NOW } from "./support/meals";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const WORDS = "I think I am in over my head.";
const sf = () => ({ query: async () => [] });
const deps = () => ({ db, sf, now: NOW });
const acceptTool = TOOLS.find((x) => x.name === "care_accept_proposal")!;
const NEW_TARGET = { target: { kind: "new" }, person: { newOutsidePerson: { name: "Someone Else" } }, category: "other", summary: "A note" };

const item = (restricted: boolean, sfContactId = CONTACT) => createCareItem(db, t.clergy, { sfContactId, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "Private summary", restricted });

/** A flag on a task the item's owner posted for `careItemId`. Every timestamp is the test's clock, never the database's. */
async function flagged(careItemId: string): Promise<string> {
  const task = await createVolunteerTask(db, t.clergy, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-05", careItemId }, NOW);
  const r = await claimTask(db, task.publicToken, { firstName: "Sam", lastName: "Katz", contact: `sam${Math.random()}@example.test`, note: "", mayAskAgain: false }, meta(), NOW);
  if (!r.ok) throw new Error(r.reason);
  await db.update(volunteerClaims).set({ createdAt: NOW }).where(eq(volunteerClaims.id, r.claimId));
  expect(await flagForRabbis(db, r.manageToken, WORDS, meta(), NOW)).toEqual({ ok: true });
  const [p] = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.scopeCareItemId, careItemId));
  await db.update(proposals).set({ createdAt: NOW }).where(eq(proposals.id, p.id));
  return p.id;
}

beforeEach(async () => {
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("accepting a flag scoped to a RESTRICTED care item", () => {
  it("may only add it to that same item; a new item, another item or a new restricted item is refused, in the app and the connector", async () => {
    const scoped = await item(true);
    const other = await item(false, CONTACT2);
    const id = await flagged(scoped.id);
    const refusals: unknown[] = [NEW_TARGET, { ...NEW_TARGET, restricted: true, accessUserIds: [t.clergy2.id] }, { target: { kind: "existing", careItemId: other.id }, summary: "A note" }];
    for (const decision of refusals) await expect(acceptProposal(deps(), t.clergy, id, decision)).rejects.toBeInstanceOf(InvalidInput);
    const viaConnector = await callTool(acceptTool, { proposalId: id, addToCareItemId: other.id, summary: "A note" }, { db, sf, now: NOW, actor: t.clergy });
    expect(viaConnector.isError).toBe(true);
    expect((await callTool(acceptTool, { proposalId: id, newOutsidePerson: { name: "Someone Else" }, category: "other", summary: "A note" }, { db, sf, now: NOW, actor: t.clergy })).isError).toBe(true);
    // Still pending after every refusal.
    expect((await listInbox(db, t.clergy)).map((p) => p.id)).toEqual([id]);
    const ok = await callTool(acceptTool, { proposalId: id, addToCareItemId: scoped.id, summary: "A volunteer is worried" }, { db, sf, now: NOW, actor: t.clergy });
    expect(ok.isError).toBe(false);
    // The kept words are read back only on that item, by those it is open to.
    expect((await getOriginalReports(db, t.clergy, [scoped.id])).get(scoped.id)?.[0]?.words).toContain(WORDS);
    expect((await getOriginalReports(db, t.clergy2, [scoped.id])).get(scoped.id)).toBeUndefined();
    expect((await getOriginalReports(db, t.owner, [scoped.id, other.id])).size).toBe(0);
  });
});

describe("a flag scoped to an UNRESTRICTED care item", () => {
  it("may be accepted as usual (a new item, too), and the accept sheet starts as an addition to that item", async () => {
    const open = await item(false);
    const id = await flagged(open.id);
    const [p] = await listInbox(db, t.clergy2);
    const entry: InboxEntry = { proposal: p, person: null, candidates: [], existing: [], nameMatches: [], matchPending: false, canReread: false, suggestedOwnerName: null, own: false, intake: null, scope: { careItemId: open.id, restricted: false, label: { displayName: "Ruth Cohen", category: "illness" } } };
    expect(initialFor(entry)).toMatchObject({ existingCareItemId: open.id, existing: [{ id: open.id, category: "illness" }] });
    expect((await acceptProposal(deps(), t.clergy2, id, NEW_TARGET)).careItemId).not.toBe(open.id);
  });
});

describe("Closed without action", () => {
  it("a dismissed scoped flag is counted, listed, usable as a cursor and reopened only by those the item is open to", async () => {
    const scoped = await item(true);
    // An older ordinary report everyone may see, dismissed first.
    const plain = await createProposal(db, t.staff, { rawText: "A plain report", channel: "staff" });
    await dismissProposal(db, t.clergy, plain.id, new Date(NOW.getTime() - 60_000));
    const id = await flagged(scoped.id);
    await dismissProposal(db, t.clergy, id, NOW);

    for (const outsider of [t.owner, t.clergy2] as Actor[]) {
      expect(await countClosedReports(db, outsider)).toBe(1);
      expect((await listClosedReports(db, outsider)).reports.map((r) => r.id)).toEqual([plain.id]);
      // As a cursor it finds nothing: no page, so nothing is learned of when it was closed.
      expect((await listClosedReports(db, outsider, { before: id })).reports).toEqual([]);
      await expect(reopenProposal(db, outsider, id)).rejects.toBeInstanceOf(NotFound);
    }
    expect(await countClosedReports(db, t.clergy)).toBe(2);
    expect((await listClosedReports(db, t.clergy)).reports.map((r) => r.id)).toEqual([id, plain.id]);
    expect((await listClosedReports(db, t.clergy, { before: id })).reports.map((r) => r.id)).toEqual([plain.id]);
    expect(await reopenProposal(db, t.clergy, id)).toEqual({ id });
    expect((await listInbox(db, t.clergy)).map((p) => p.id)).toEqual([id]);
    expect(await listInbox(db, t.owner)).toEqual([]);
  });
});
