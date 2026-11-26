import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createContactEntry, listContactEntries, updateContactEntry } from "@/server/care/contact-log";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { ACCOUNT, CONTACT, team, testDb } from "./support/db";

const SECRET = "Confided about a diagnosis";

async function setup() {
  const db = await testDb();
  const t = await team(db);
  const shared = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth", category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
  return { db, t, shared };
}

const at = "2026-11-20T15:00:00Z";

afterEach(() => vi.restoreAllMocks());

describe("contact log", () => {
  it("clergy log a contact and all clergy read a non-private note", async () => {
    const { db, t } = await setup();
    const e = await createContactEntry(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth", kind: "visit", occurredAt: at, note: "Hospital visit" });
    expect(e).toMatchObject({ kind: "visit", note: "Hospital visit", private: false, noteHidden: false });
    const seenByOther = await listContactEntries(db, t.clergy2, { sfContactId: CONTACT });
    expect(seenByOther).toHaveLength(1);
    expect(seenByOther[0]).toMatchObject({ note: "Hospital visit", noteHidden: false, authorName: "clergy" });
  });

  it("a private note is shown only to its author; others see that a contact happened and when", async () => {
    const { db, t } = await setup();
    await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", kind: "call", occurredAt: at, note: SECRET, private: true });
    expect((await listContactEntries(db, t.clergy, { sfContactId: CONTACT }))[0].note).toBe(SECRET);
    for (const other of [t.owner, t.clergy2]) {
      const [row] = await listContactEntries(db, other, { sfContactId: CONTACT });
      expect(row).toMatchObject({ note: null, noteHidden: true, kind: "call", private: true, authorUserId: t.clergy.id });
      expect(row.occurredAt.toISOString()).toBe(new Date(at).toISOString());
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
  });

  it("caregivers never see clergy entries, only their own", async () => {
    const { db, t, shared } = await setup();
    await createContactEntry(db, t.clergy, { careItemId: shared.id, kind: "visit", occurredAt: at, note: "Clergy note" });
    const mine = await createContactEntry(db, t.carer, { careItemId: shared.id, kind: "text", occurredAt: at, note: "Sent flowers" });
    expect(mine).toMatchObject({ sfContactId: CONTACT, displayName: "Ruth", careItemId: shared.id });
    const list = await listContactEntries(db, t.carer, { careItemId: shared.id });
    expect(list.map((r) => r.id)).toEqual([mine.id]);
    expect(JSON.stringify(await listContactEntries(db, t.carer))).not.toContain("Clergy note");
    expect(await listContactEntries(db, t.carer2)).toEqual([]);
    // Clergy read a caregiver's non-private note.
    expect((await listContactEntries(db, t.clergy, { careItemId: shared.id })).map((r) => r.note).sort()).toEqual(["Clergy note", "Sent flowers"]);
  });

  it("caregivers log only against a care item they can see", async () => {
    const { db, t, shared } = await setup();
    await expect(createContactEntry(db, t.carer, { sfContactId: CONTACT, displayName: "Ruth", kind: "call", occurredAt: at })).rejects.toBeInstanceOf(AccessDenied);
    await expect(createContactEntry(db, t.carer2, { careItemId: shared.id, kind: "call", occurredAt: at })).rejects.toBeInstanceOf(NotFound);
  });

  it("only the author edits, including the private flag", async () => {
    const { db, t } = await setup();
    const e = await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", kind: "call", occurredAt: at, note: "n" });
    await expect(updateContactEntry(db, t.owner, e.id, { private: false, note: "rewritten" })).rejects.toBeInstanceOf(AccessDenied);
    await expect(updateContactEntry(db, t.carer, e.id, { note: "x" })).rejects.toBeInstanceOf(NotFound);
    const updated = await updateContactEntry(db, t.clergy, e.id, { private: true, kind: "visit" });
    expect(updated).toMatchObject({ private: true, kind: "visit", note: "n" });
    expect((await listContactEntries(db, t.owner))[0].note).toBeNull();
  });

  it("validates input without echoing note text", async () => {
    const { db, t } = await setup();
    const huge = SECRET + "x".repeat(6000);
    const err = await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", kind: "call", occurredAt: at, note: huge }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInput);
    expect(String(err.message)).not.toContain(SECRET);
    await expect(createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", kind: "email", occurredAt: at })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", kind: "call", occurredAt: "yesterday-ish" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", kind: "call", occurredAt: at, private: "yes" })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("never writes note text to the console", async () => {
    const { db, t } = await setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", kind: "call", occurredAt: at, note: SECRET, private: true });
    await listContactEntries(db, t.owner);
    await listContactEntries(db, t.clergy);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
  });
});
