import { describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { listMarkKeys, markKey, markOccasion, unmarkOccasion } from "@/server/care/occasion-marks";
import { addUser, listTeam, updateUser } from "@/server/care/users";
import { InvalidInput } from "@/server/care/validate";
import { ACCOUNT, addActor, CONTACT, team, testDb } from "./support/db";

const YAHRZEIT = "a0B000000000001AAA";
const OWNERS = new Set(["owner@example.test"]);

describe("occasion marks", () => {
  it("marks an occasion done for the year, shared by the team, idempotently", async () => {
    const db = await testDb();
    const t = await team(db);
    const input = { occasionType: "yahrzeit", subjectId: YAHRZEIT, sfAccountId: ACCOUNT, sfContactId: CONTACT, year: 2026 };
    await markOccasion(db, t.clergy, input);
    await markOccasion(db, t.clergy2, input);
    const keys = await listMarkKeys(db, t.owner, [2026]);
    expect([...keys]).toEqual([markKey({ occasionType: "yahrzeit", subjectId: YAHRZEIT, sfAccountId: ACCOUNT, year: 2026 })]);
    expect((await listMarkKeys(db, t.owner, [2027])).size).toBe(0);
    await unmarkOccasion(db, t.owner, input);
    expect((await listMarkKeys(db, t.owner, [2026])).size).toBe(0);
  });

  it("marks are per household: another observing household is still open", async () => {
    const db = await testDb();
    const t = await team(db);
    await markOccasion(db, t.clergy, { occasionType: "yahrzeit", subjectId: YAHRZEIT, sfAccountId: ACCOUNT, year: 2026 });
    const keys = await listMarkKeys(db, t.clergy, [2026]);
    expect(keys.has(markKey({ occasionType: "yahrzeit", subjectId: YAHRZEIT, sfAccountId: "001000000000009AAA", year: 2026 }))).toBe(false);
  });

  it("validates ids and refuses caregivers", async () => {
    const db = await testDb();
    const t = await team(db);
    await expect(markOccasion(db, t.clergy, { occasionType: "yahrzeit", subjectId: "x' OR '1'='1", year: 2026 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(markOccasion(db, t.clergy, { occasionType: "wedding", subjectId: YAHRZEIT, year: 2026 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(markOccasion(db, t.clergy, { occasionType: "birthday", subjectId: CONTACT, year: Number.NaN })).rejects.toBeInstanceOf(InvalidInput);
    await expect(markOccasion(db, t.carer, { occasionType: "birthday", subjectId: CONTACT, year: 2026 })).rejects.toBeInstanceOf(AccessDenied);
    await expect(listMarkKeys(db, t.carer, [2026])).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("team management", () => {
  it("owners add, demote and deactivate members; nobody else can", async () => {
    const db = await testDb();
    const t = await team(db);
    const added = await addUser(db, t.owner, { email: " New@CRC.test ", name: "New", role: "clergy" });
    expect(added).toMatchObject({ email: "new@crc.test", role: "clergy", active: true });
    expect((await updateUser(db, t.owner, added.id, { role: "caregiver", active: false }, OWNERS)).active).toBe(false);
    await expect(addUser(db, t.clergy, { email: "x@crc.test", role: "clergy" })).rejects.toBeInstanceOf(AccessDenied);
    await expect(updateUser(db, t.clergy, added.id, { active: true }, OWNERS)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("the owner role comes only from OWNER_EMAILS, and a current owner's row cannot be edited here", async () => {
    const db = await testDb();
    const t = await team(db);
    await expect(addUser(db, t.owner, { email: "x@crc.test", role: "owner" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateUser(db, t.owner, t.clergy.id, { role: "owner" }, OWNERS)).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateUser(db, t.owner, t.owner.id, { active: false }, OWNERS)).rejects.toBeInstanceOf(InvalidInput);
    await expect(addUser(db, t.owner, { email: "clergy@example.test", role: "clergy" })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("an owner row whose email left OWNER_EMAILS can be demoted or deactivated by a current owner", async () => {
    const db = await testDb();
    const t = await team(db);
    const former = await addActor(db, "former-owner@example.test", "owner");
    const other = await addActor(db, "other-former@example.test", "owner");
    // Still listed: protected.
    await expect(updateUser(db, t.owner, former.id, { active: false }, new Set([...OWNERS, former.email]))).rejects.toBeInstanceOf(InvalidInput);
    // Removed from the list: an ordinary member.
    expect(await updateUser(db, t.owner, former.id, { role: "caregiver" }, OWNERS)).toMatchObject({ role: "caregiver", active: true });
    expect(await updateUser(db, t.owner, other.id, { active: false }, OWNERS)).toMatchObject({ role: "clergy", active: false });
    // Only a current owner may do it; the stale owner (acting as clergy) may not.
    await expect(updateUser(db, { ...other, role: "clergy" }, former.id, { active: false }, OWNERS)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("a caregiver sees only themselves in the team list", async () => {
    const db = await testDb();
    const t = await team(db);
    expect((await listTeam(db, t.carer)).map((u) => u.id)).toEqual([t.carer.id]);
    expect(await listTeam(db, t.clergy)).toHaveLength(5);
  });
});
