import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { parseOwnerEmails } from "@/server/access/policy";
import { isEmailAllowed, resolveActor } from "@/server/access/actor";
import { listTeam, updateUser } from "@/server/care/users";
import type { Db } from "@/server/db/types";
import { team, testDb } from "./support/db";

let db: Db;
const owners = parseOwnerEmails("owner@example.test");

beforeEach(async () => {
  db = await testDb();
});

describe("sign-in does not depend on the newest users column", () => {
  it("resolves actors, adds and changes people against a database that has not run migration 0010", async () => {
    const t = await team(db);
    // The schema as it was before 0010: no today_prefs column.
    await db.execute(sql`alter table users drop column today_prefs`);
    expect(await resolveActor(db, { email: "clergy@example.test" }, owners)).toMatchObject({ role: "clergy" });
    expect(await resolveActor(db, { email: "owner@example.test" }, owners)).toMatchObject({ role: "owner" });
    expect(await resolveActor(db, { email: "stranger@example.test" }, owners)).toBeNull();
    expect(await isEmailAllowed(db, "clergy2@example.test", owners)).toBe(true);
    expect((await listTeam(db, t.owner)).length).toBeGreaterThan(3);
    expect(await updateUser(db, t.owner, t.clergy2.id, { active: false }, owners)).toMatchObject({ active: false });
  });
});
