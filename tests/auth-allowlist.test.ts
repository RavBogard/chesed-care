import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isEmailAllowed, resolveActor } from "@/server/access/actor";
import { parseOwnerEmails } from "@/server/access/policy";
import { createAuth } from "@/server/auth/factory";
import { authUser } from "@/server/db/auth-schema";
import { users } from "@/server/db/schema";
import { addActor, testDb } from "./support/db";

const owners = parseOwnerEmails("rabbi@crc.test");

describe("resolveActor", () => {
  it("creates an active owner row for an OWNER_EMAILS address on first sign-in", async () => {
    const db = await testDb();
    const actor = await resolveActor(db, { email: "Rabbi@CRC.test", name: "Rabbi" }, owners);
    expect(actor).toMatchObject({ email: "rabbi@crc.test", role: "owner", name: "Rabbi" });
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "rabbi@crc.test", role: "owner", active: true });
    // Second sign-in reuses the same row.
    const again = await resolveActor(db, { email: "rabbi@crc.test" }, owners);
    expect(again?.id).toBe(actor?.id);
  });

  it("restores an owner row that was deactivated or demoted", async () => {
    const db = await testDb();
    await addActor(db, "rabbi@crc.test", "caregiver", false);
    const actor = await resolveActor(db, { email: "rabbi@crc.test" }, owners);
    expect(actor?.role).toBe("owner");
    const [row] = await db.select().from(users).where(eq(users.email, "rabbi@crc.test"));
    expect(row).toMatchObject({ role: "owner", active: true });
  });

  it("returns listed active users with their role, case-insensitively", async () => {
    const db = await testDb();
    const c = await addActor(db, "cantor@crc.test", "clergy");
    expect(await resolveActor(db, { email: "CANTOR@crc.test" }, owners)).toMatchObject({ id: c.id, role: "clergy" });
  });

  it("returns null for strangers and inactive users, and creates no row", async () => {
    const db = await testDb();
    await addActor(db, "gone@crc.test", "clergy", false);
    expect(await resolveActor(db, { email: "stranger@gmail.test" }, owners)).toBeNull();
    expect(await resolveActor(db, { email: "gone@crc.test" }, owners)).toBeNull();
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("treats a database owner row without OWNER_EMAILS as clergy", async () => {
    const db = await testDb();
    await addActor(db, "old-owner@crc.test", "owner");
    expect((await resolveActor(db, { email: "old-owner@crc.test" }, owners))?.role).toBe("clergy");
  });
});

describe("better-auth hooks enforce the allowlist before any session exists", () => {
  async function setup() {
    const db = await testDb();
    const auth = createAuth(db, {
      origin: "http://localhost:3000",
      secret: randomBytes(48).toString("base64url"),
      google: { clientId: "synthetic", clientSecret: "synthetic" },
      ownerEmails: owners,
    });
    const hooks = auth.options.databaseHooks!;
    return { db, auth, userBefore: hooks.user!.create!.before!, sessionBefore: hooks.session!.create!.before! };
  }
  const baseUser = { id: "a1", name: "N", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };

  it("refuses to create an auth user for an email not on the list", async () => {
    const { userBefore } = await setup();
    expect(await userBefore({ ...baseUser, email: "stranger@gmail.test" })).toBe(false);
  });

  it("refuses an unverified email even when it is an owner address", async () => {
    const { userBefore } = await setup();
    expect(await userBefore({ ...baseUser, email: "rabbi@crc.test", emailVerified: false })).toBe(false);
  });

  it("allows owners and active listed users", async () => {
    const { db, userBefore } = await setup();
    await addActor(db, "cantor@crc.test", "clergy");
    expect(await userBefore({ ...baseUser, email: "rabbi@crc.test" })).toBeUndefined();
    expect(await userBefore({ ...baseUser, email: "Cantor@crc.test" })).toBeUndefined();
  });

  it("refuses a new session once a user has been deactivated", async () => {
    const { db, sessionBefore } = await setup();
    await addActor(db, "cantor@crc.test", "clergy");
    await db.insert(authUser).values({ id: "au1", name: "C", email: "cantor@crc.test", emailVerified: true });
    const session = { id: "s1", userId: "au1", token: "t", expiresAt: new Date(Date.now() + 1e6), createdAt: new Date(), updatedAt: new Date() };
    expect(await sessionBefore(session)).toBeUndefined();
    await db.update(users).set({ active: false }).where(eq(users.email, "cantor@crc.test"));
    expect(await sessionBefore(session)).toBe(false);
    expect(await sessionBefore({ ...session, userId: "missing" })).toBe(false);
  });

  it("requests only basic Google profile scopes and disables password sign-in", async () => {
    const { auth } = await setup();
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
    expect(Object.keys(auth.options.socialProviders ?? {})).toEqual(["google"]);
    expect((auth.options.socialProviders as { google: { scope?: string[] } }).google.scope).toBeUndefined();
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      }),
    );
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/google");
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(["email", "openid", "profile"]);
  });

  it("has no session without a cookie (adapter wired to the schema)", async () => {
    const { auth } = await setup();
    const res = await auth.handler(new Request("http://localhost:3000/api/auth/get-session"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("isEmailAllowed matches the policy", async () => {
    const { db } = await setup();
    await addActor(db, "carer@crc.test", "caregiver");
    expect(await isEmailAllowed(db, "carer@crc.test", owners)).toBe(true);
    expect(await isEmailAllowed(db, "nobody@crc.test", owners)).toBe(false);
  });
});
