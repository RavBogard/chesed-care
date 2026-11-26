import { inspect } from "node:util";
import { serializeSignedCookie } from "better-call";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authSession, authUser } from "@/server/db/auth-schema";
import { DatabaseError } from "@/server/db/errors";
import type { Db } from "@/server/db/types";
import { testDb } from "./support/db";

const SECRET = "test-secret-test-secret-test-secret-0123456789";
const TOKEN = "sessiontokenvalue0123456789abcdef";
const EMAIL = "cantor.private@crc.test";

let db: Db;
let cookie = "";

vi.mock("@/server/db/client", () => ({ getDb: () => db, isDatabaseConfigured: () => true }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie }) }));

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("OWNER_EMAILS", "rabbi@crc.test");
  db = await testDb();
  await db.insert(authUser).values({ id: "auth-user-1", name: "Cantor", email: EMAIL, emailVerified: true });
  await db.insert(authSession).values({ id: "auth-session-1", token: TOKEN, userId: "auth-user-1", expiresAt: new Date(Date.now() + 86_400_000), updatedAt: new Date() });
  cookie = (await serializeSignedCookie("better-auth.session_token", TOKEN, SECRET)).split(";")[0];
});

afterEach(() => vi.restoreAllMocks());

function captureConsole(): () => string {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 }))).join(" "));
    });
  }
  return () => lines.join("\n");
}

function expectNoLeak(error: unknown, output: string) {
  for (const text of [String(error), (error as Error).stack ?? "", inspect(error, { depth: 10, showHidden: true }), JSON.stringify(error), output]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("params");
  }
}

describe("getViewer when the database fails", () => {
  it("the session lookup is real: a working database resolves the signed-in user", async () => {
    await db.execute(sql`insert into users (email, name, role, active) values (${EMAIL}, 'Cantor', 'clergy', true)`);
    const { getViewer } = await import("@/server/auth/session");
    expect(await getViewer()).toMatchObject({ kind: "ok", actor: { email: EMAIL, role: "clergy" } });
  });

  it("a failing session lookup exposes neither the token nor the email", async () => {
    const { getViewer } = await import("@/server/auth/session");
    await db.execute(sql`alter table auth_session rename to auth_session_gone`);
    try {
      const output = captureConsole();
      const error = await getViewer().catch((e: unknown) => e);
      console.error("viewer failed", error);
      // better-auth replaces it with its own "Failed to get session"; either way, nothing leaks.
      expect(error).toBeInstanceOf(Error);
      expectNoLeak(error, output());
    } finally {
      await db.execute(sql`alter table auth_session_gone rename to auth_session`);
    }
  });

  it("a failing allowlist lookup after a valid session exposes neither the token nor the email", async () => {
    const { getViewer } = await import("@/server/auth/session");
    await db.execute(sql`alter table users rename to users_gone`);
    try {
      const output = captureConsole();
      const error = await getViewer().catch((e: unknown) => e);
      console.error("viewer failed", error);
      expect(error).toBeInstanceOf(DatabaseError);
      expectNoLeak(error, output());
    } finally {
      await db.execute(sql`alter table users_gone rename to users`);
    }
  });
});
