import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import webpush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TellForm } from "@/components/tell/tell-form";
import { TELL_KEEP } from "@/lib/tell-wording";
import { type Actor } from "@/server/access/policy";
import { addAgendaEntry, listAgenda } from "@/server/care/agenda";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { createPublicProposal } from "@/server/care/intake";
import { MAX_OFFSET, searchNotes } from "@/server/care/notes-search";
import { createOutsidePerson, updateOutsidePerson } from "@/server/care/outside-people";
import { createProposal } from "@/server/care/proposals";
import { runDailyJob } from "@/server/daily/run";
import { countStaleReporters } from "@/server/daily/housekeeping";
import { agendaEntries, auditLog, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { noticeUrgentProposal } from "@/server/notify/notify";
import { savePrefs } from "@/server/notify/prefs";
import { subscribeDevice } from "@/server/notify/subscriptions";
import { getCovering, setAway } from "@/server/team/away";
import { CONTACT, CONTACT2, addActor, team, testDb } from "./support/db";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));
const sendNotification = vi.mocked(webpush.sendNotification);
const OWNERS: ReadonlySet<string> = new Set(["owner@example.test"]);
const PUSH_ENV = { VAPID_PUBLIC_KEY: "BPublicKeyForTestsOnly", VAPID_PRIVATE_KEY: "private-key-for-tests-only", VAPID_SUBJECT: "mailto:care@example.test" };
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
// Tuesday 12:00 in Chicago.
const NOW = new Date("2026-12-01T18:00:00Z");
const DAY = 86_400_000;
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let third: Actor;

beforeEach(async () => {
  for (const [k, v] of Object.entries(PUSH_ENV)) vi.stubEnv(k, v);
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  db = await testDb();
  t = await team(db);
  third = await addActor(db, "clergy3@example.test", "clergy");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const restrictedAudits = () => db.select().from(auditLog).then((rows) => rows.filter((r) => r.action === "restricted.view"));

describe("audit of restricted reads", () => {
  it("search in notes records a named colleague's read of a restricted item (ids only), and not the owner's own", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true, summary: "Quokka diagnosis", accessUserIds: [t.clergy2.id] });
    await searchNotes(db, t.clergy, "quokka", {}, NOW);
    expect(await restrictedAudits()).toHaveLength(0);
    await searchNotes(db, t.clergy2, "quokka", {}, NOW);
    const rows = await restrictedAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: t.clergy2.id, subjectId: item.id });
    expect(JSON.stringify(rows)).not.toMatch(/quokka|Hannah/i);
  });

  it("the coverer's section records a read of a restricted follow-up they are named on", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Named Nora", category: "illness", restricted: true, accessUserIds: [t.clergy2.id] });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: "2026-12-02" });
    await setAway(db, t.clergy, t.clergy.id, { from: "2026-12-01", until: "2026-12-05", coverUserId: t.clergy2.id }, NOW);
    const [section] = await getCovering(db, t.clergy2, "2026-12-01");
    expect(section.followUps).toHaveLength(1);
    expect((await restrictedAudits()).map((r) => [r.actorUserId, r.subjectId])).toEqual([[t.clergy2.id, item.id]]);
  });
});

describe("the public form says what is kept", () => {
  it("shows the keep-for-30-days sentence under the question", () => {
    const html = renderToStaticMarkup(<TellForm stamp="x" />);
    expect(html).toContain('data-testid="tell-keep"');
    expect(html.replace(/&#x27;|&apos;/g, "'")).toContain(TELL_KEEP.replace(/&/g, "&amp;"));
  });
});

describe("retention", () => {
  // Daniel, 2026-11-25: "I want it all kept." What clergy wrote on the agenda is not cleared or deleted on a timer.
  // The rows are stamped by the real clock, so the days are counted from it (a fixed date here went stale).
  const after = (days: number) => runDailyJob({ db, now: new Date(Date.now() + days * DAY), owners: new Set(["owner@example.test"]), origin: null });

  it("keeps an undiscussed agenda entry however old its week is: after 90 days, a year and five years", async () => {
    await addAgendaEntry(db, t.clergy, { displayName: "Old line" });
    for (const days of [80, 100, 365, 5 * 365]) {
      expect((await after(days)).every((r) => r.ok)).toBe(true);
      expect((await db.select().from(agendaEntries)).map((e) => e.displayName)).toEqual(["Old line"]);
    }
    // Still on the agenda to be discussed, carried or removed by a person.
    expect((await listAgenda(db, t.clergy, new Date(Date.now() + 365 * DAY))).toDiscuss.map((e) => e.displayName)).toEqual(["Old line"]);
  });

  it("keeps the words of free-text and person-level entries after 90 days, a year and five years", async () => {
    await addAgendaEntry(db, t.clergy, { displayName: "Free line", why: "some words" });
    await addAgendaEntry(db, t.clergy, { sfContactId: CONTACT2, displayName: "Person line", why: "person words" });
    for (const days of [60, 91, 365, 5 * 365]) {
      await after(days);
      expect((await db.select().from(agendaEntries)).map((e) => e.why).sort()).toEqual(["person words", "some words"]);
    }
  });

  it("counts reporter rows past 30 days (expected 0 once the job has run)", async () => {
    const id = await createPublicProposal(db, { rawText: "w", intake: { kind: "public_form", about: "a", sender: "b", contact: "b@x.test" }, mayTellThem: "yes", miSheberach: "no" });
    await db.update(proposals).set({ status: "accepted", decidedAt: NOW, reporterName: "b", reporterEmail: "b@x.test" }).where(eq(proposals.id, id));
    expect(await countStaleReporters(db, new Date(NOW.getTime() + 29 * DAY))).toBe(0);
    expect(await countStaleReporters(db, new Date(NOW.getTime() + 31 * DAY))).toBe(1);
  });
});

describe("search paging and a rename", () => {
  it("caps the offset and offers no more beyond it", async () => {
    await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness", summary: "Pneumonia" });
    const far = await searchNotes(db, t.clergy, "pneumonia", { offset: 10_000 }, NOW);
    expect(far.offset).toBe(MAX_OFFSET);
    expect(far.hasMore).toBe(false);
  });

  it("a rename also updates the agenda entry's name, and the restricted flag follows the item", async () => {
    const p = await createOutsidePerson(db, t.clergy, { name: "Old Name" });
    await addAgendaEntry(db, t.clergy, { outsidePersonId: p.id }, NOW);
    await updateOutsidePerson(db, t.clergy, p.id, { name: "New Name" });
    expect((await listAgenda(db, t.clergy, NOW)).toDiscuss[0].displayName).toBe("New Name");
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness" });
    const secret = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "illness", restricted: true });
    await addAgendaEntry(db, t.clergy, { careItemId: plain.id }, NOW);
    await addAgendaEntry(db, t.clergy, { careItemId: secret.id }, NOW);
    const flags = new Map((await listAgenda(db, t.clergy, NOW)).toDiscuss.map((e) => [e.careItemId, e.restricted]));
    expect(flags.get(plain.id)).toBe(false);
    expect(flags.get(secret.id)).toBe(true);
  });
});

describe("urgent notices while someone is away", () => {
  const device = (a: Actor) => subscribeDevice(db, a, { endpoint: `https://fcm.googleapis.com/fcm/send/${a.id}-1`, ...KEYS, userAgent: "Mozilla/5.0 (iPhone)" });
  const recipients = () => [...new Set(sendNotification.mock.calls.map(([sub]) => (sub as { endpoint: string }).endpoint.split("/").pop()!.replace(/-\d+$/, "")))].sort();
  let reporter: Actor;
  const arrive = () => createProposal(db, reporter, { rawText: "A short report", channel: "staff", reading: { summary: "Needs a call", urgency: "today" }, reviewScope: "clergy" });

  beforeEach(async () => {
    reporter = await addActor(db, "staff@example.test", "staff");
    for (const a of [t.owner, t.clergy, t.clergy2, third]) await device(a);
    await setAway(db, t.clergy, t.clergy.id, { from: "2026-12-01", until: "2026-12-05", coverUserId: third.id }, NOW);
  });

  it("the away person is not told while away, and their coverer is", async () => {
    const p = await arrive();
    await noticeUrgentProposal(db, p.id, NOW, OWNERS);
    expect(recipients()).not.toContain(t.clergy.id);
    expect(recipients()).toEqual([t.owner.id, t.clergy2.id, third.id].sort());
  });

  it("the coverer is told even when no one else would be, and an explicit off is respected", async () => {
    for (const a of [t.owner, t.clergy2]) await savePrefs(db, a, { kinds: { urgent_inbox: false, new_inbox: false, assigned: true, coordinator: false }, quietEnabled: true, quietStartHour: 21, quietEndHour: 7, urgentIgnoresQuiet: true });
    const p = await arrive();
    await noticeUrgentProposal(db, p.id, NOW, OWNERS);
    expect(recipients()).toEqual([third.id]);
    sendNotification.mockClear();
    await savePrefs(db, third, { kinds: { urgent_inbox: false, new_inbox: false, assigned: true, coordinator: false }, quietEnabled: true, quietStartHour: 21, quietEndHour: 7, urgentIgnoresQuiet: true });
    const p2 = await arrive();
    await noticeUrgentProposal(db, p2.id, NOW, OWNERS);
    expect(recipients()).toEqual([]);
  });

  it("after the window ends the person is told again", async () => {
    const p = await arrive();
    await noticeUrgentProposal(db, p.id, new Date("2026-12-07T18:00:00Z"), OWNERS);
    expect(recipients()).toContain(t.clergy.id);
  });
});
