import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async (importActual) => ({ ...(await importActual<typeof import("ai")>()), generateText: hoisted.generate }));
vi.mock("next/server", () => ({ after: () => undefined }));

import { AccessDenied, canReviewProposal, canSeePracticalRequests, canTakePracticalRequest } from "@/server/access/policy";
import { readAndStore } from "@/server/care/ai-reading";
import { dismissProposal, listInbox, loadPending } from "@/server/care/proposals";
import { keepToClergy, listPracticalRequests, takePracticalRequest } from "@/server/care/practical";
import { submitTell } from "@/server/care/tell";
import { NotFound } from "@/server/care/validate";
import { auditLog, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { getCoordinatorHome } from "@/server/volunteers/home";
import { reporters, team, testDb } from "./support/db";
import { meta } from "./support/meals";

const NOW = new Date("2026-12-01T18:00:00Z");
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
});

const form = (over: Record<string, unknown> = {}) => ({ about: "The Cohen family", what: "A new baby. A meal on Thursday would help.", sender: "A friend", contact: "friend@example.test", mayTellThem: "yes", miSheberach: "no", help: "practical", ...over });
const send = async (over: Record<string, unknown> = {}) => {
  // Each call comes from a different client, so the per-client limit never gets in the way.
  expect(await submitTell(db, form(over), meta(), NOW)).toEqual({ ok: true });
  const rows = await db.select().from(proposals);
  return rows[rows.length - 1];
};
const row = async (id: string) => (await db.select().from(proposals).where(eq(proposals.id, id)))[0];
const leadIds = async () => (await listPracticalRequests(db, r.lead)).map((p) => p.id);

describe("what the form stores", () => {
  it("practical and clean: lead visible. Not practical, or a sensitive word: not", async () => {
    expect(await send()).toMatchObject({ practical: true, leadVisible: true });
    expect(await send({ help: "clergy" })).toMatchObject({ practical: false, leadVisible: false });
    expect(await send({ help: undefined })).toMatchObject({ practical: false, leadVisible: false });
    expect(await send({ what: "He is in rehab. Soup would help." })).toMatchObject({ practical: true, leadVisible: false });
    expect(await send({ about: "Someone struggling with depression" })).toMatchObject({ practical: true, leadVisible: false });
    expect(await submitTell(db, form({ help: "everyone" }), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("what the lead sees", () => {
  it("a practical, non-sensitive form request, as a narrow view, and no proposal through any other path", async () => {
    const p = await send();
    const seen = await listPracticalRequests(db, r.lead);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(["about", "contact", "createdAt", "id", "sender", "takenAt", "takenByMe", "takenByName", "what"]);
    expect(seen[0]).toMatchObject({ id: p.id, about: "The Cohen family", sender: "A friend", contact: "friend@example.test", takenByName: null, takenAt: null });
    // The Inbox, the review check and loading a pending proposal all refuse the lead.
    expect(await listInbox(db, r.lead)).toEqual([]);
    expect(canReviewProposal(r.lead, p)).toBe(false);
    await expect(loadPending(db, r.lead, p.id)).rejects.toBeInstanceOf(NotFound);
    await expect(keepToClergy(db, r.lead, p.id)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("nothing else: not a clergy-only form message, a sensitive one, a staff report or a Salesforce arrival", async () => {
    await send({ help: "clergy" });
    await send({ what: "She has dementia. A ride would help." });
    await db.insert(proposals).values({ channel: "staff", submittedBy: t.clergy.id, rawText: "A meal please", reviewScope: "clergy", practical: true, leadVisible: true });
    await db.insert(proposals).values({ channel: "salesforce", rawText: "x", reviewScope: "clergy", externalKey: "k1", practical: true, leadVisible: true });
    expect(await leadIds()).toEqual([]);
  });

  it("not after clergy dismiss or accept, and not after Keep this to clergy", async () => {
    const a = await send();
    const d = await send();
    const k = await send();
    expect((await leadIds()).sort()).toEqual([a.id, d.id, k.id].sort());
    await dismissProposal(db, t.clergy, d.id);
    // An accept leaves the same mark: the status is no longer pending (and the words are erased).
    await db.update(proposals).set({ status: "accepted", rawText: null, intake: null }).where(eq(proposals.id, a.id));
    expect(await leadIds()).toEqual([k.id]);
    await keepToClergy(db, t.clergy, k.id);
    expect(await leadIds()).toEqual([]);
    expect(await row(k.id)).toMatchObject({ leadVisible: false, takenBy: null, takenAt: null });
  });

  it("the coordinator home carries the section for the lead only when there is one", async () => {
    expect((await getCoordinatorHome(db, r.lead, NOW)).asked).toEqual([]);
    const p = await send();
    expect((await getCoordinatorHome(db, r.lead, NOW)).asked.map((x) => x.id)).toEqual([p.id]);
  });
});

describe("taking one", () => {
  it("first taker wins; a second person is told it is taken; the same person again is fine", async () => {
    const p = await send();
    expect(await takePracticalRequest(db, r.lead, p.id, NOW)).toEqual({ ok: true });
    expect(await takePracticalRequest(db, t.clergy, p.id, NOW)).toEqual({ ok: false, reason: "already_taken" });
    expect(await takePracticalRequest(db, r.lead, p.id, NOW)).toEqual({ ok: true });
    expect(await row(p.id)).toMatchObject({ takenBy: r.lead.id, takenAt: NOW });
    const [seen] = await listPracticalRequests(db, t.clergy);
    expect(seen).toMatchObject({ takenByName: "lead", takenByMe: false });
    expect((await listInbox(db, t.clergy))[0]).toMatchObject({ takenByName: "lead", practical: true, leadVisible: true });
  });

  it("writes an audit entry with no words in it", async () => {
    const p = await send();
    await takePracticalRequest(db, r.lead, p.id, NOW);
    const rows = await db.select().from(auditLog);
    expect(rows.map((x) => [x.action, x.actorUserId, x.subjectId, x.detail])).toEqual([["proposal.practical_take", r.lead.id, p.id, null]]);
  });

  it("a request the lead cannot see looks like one that does not exist", async () => {
    const hidden = await send({ what: "Rehab next week. A ride would help." });
    await expect(takePracticalRequest(db, r.lead, hidden.id, NOW)).rejects.toBeInstanceOf(NotFound);
    await expect(takePracticalRequest(db, r.lead, "not-an-id", NOW)).rejects.toBeInstanceOf(NotFound);
  });
});

describe("roles", () => {
  it("caregiver, staff and senior staff see and take nothing", async () => {
    const p = await send();
    for (const who of [t.carer, r.staff, r.senior]) {
      expect(canSeePracticalRequests(who)).toBe(false);
      expect(canTakePracticalRequest(who)).toBe(false);
      await expect(listPracticalRequests(db, who)).rejects.toBeInstanceOf(AccessDenied);
      await expect(takePracticalRequest(db, who, p.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(keepToClergy(db, who, p.id)).rejects.toBeInstanceOf(AccessDenied);
    }
    for (const who of [t.owner, t.clergy, r.lead]) expect(canSeePracticalRequests(who)).toBe(true);
  });

  it("owner and clergy may keep it to clergy; it stays in the clergy Inbox as clergy only", async () => {
    const p = await send();
    await keepToClergy(db, t.owner, p.id);
    expect(await leadIds()).toEqual([]);
    expect(await listPracticalRequests(db, t.clergy)).toEqual([]);
    expect((await listInbox(db, t.clergy))[0]).toMatchObject({ practical: true, leadVisible: false });
  });
});

describe("the AI reading", () => {
  const answer = (over: Record<string, unknown> = {}) => ({ names: ["Cohen"], summary: "A new baby.", category: "birth", urgency: "routine", dates: [], sensitive: false, followUp: "", evidence: [], ...over });
  const read = async (id: string, out: Record<string, unknown>) => {
    vi.stubEnv("CARE_AI_SORTING", "on");
    vi.stubEnv("VERCEL_ENV", "");
    hoisted.generate.mockResolvedValue({ output: out });
    return readAndStore(db, id, NOW);
  };

  it("urgent or sensitive lowers lead_visible and the lead loses it", async () => {
    for (const over of [{ urgency: "today" }, { sensitive: true }, { summary: "Recovering after an overdose." }]) {
      const p = await send();
      expect(await read(p.id, answer(over))).toBe("read");
      expect(await row(p.id)).toMatchObject({ leadVisible: false, practical: true });
    }
    expect(await leadIds()).toEqual([]);
  });

  it("a calm reading leaves it visible, and a reading never makes a hidden one visible", async () => {
    const calm = await send();
    expect(await read(calm.id, answer())).toBe("read");
    expect((await row(calm.id)).leadVisible).toBe(true);
    const hidden = await send({ what: "Rehab next week. A ride would help." });
    expect(await read(hidden.id, answer())).toBe("read");
    expect((await row(hidden.id)).leadVisible).toBe(false);
    const clergyOnly = await send({ help: "clergy" });
    expect(await read(clergyOnly.id, answer())).toBe("read");
    expect((await row(clergyOnly.id)).leadVisible).toBe(false);
  });
});
