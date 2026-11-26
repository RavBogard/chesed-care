import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContactEntry } from "@/server/care/contact-log";
import { DatabaseError, isDatabaseErrorGuardInstalled, originalDatabaseError } from "@/server/db/errors";
import { ACCOUNT, CONTACT, team, testDb } from "./support/db";

const NOTE = "Told me in confidence about the diagnosis";

afterEach(() => vi.restoreAllMocks());

/** Everything a log line could show of an error. */
function renderings(error: unknown): string[] {
  return [String(error), (error as Error).stack ?? "", inspect(error, { depth: 10 }), inspect(error, { depth: 10, showHidden: true }), JSON.stringify(error)];
}

function captureConsole(): () => string {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 }))).join(" "));
    });
  }
  return () => lines.join("\n");
}

describe("database error boundary", () => {
  it("the runtime client module installs the guard", async () => {
    await import("@/server/db/client");
    expect(isDatabaseErrorGuardInstalled()).toBe(true);
  });

  it("a failing contact-log write exposes neither the note text nor the SQL parameters", async () => {
    const db = await testDb();
    const t = await team(db);
    // Every insert now fails; Postgres would put the failing row (with the note) in `detail`.
    await db.execute(sql`alter table contact_log add constraint reject_all check (false) not valid`);
    const output = captureConsole();

    const error = await createContactEntry(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth", kind: "visit", occurredAt: "2026-11-20T15:00:00Z", note: NOTE }).catch((e: unknown) => e);
    console.error("contact log write failed", error);

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ message: "Database operation failed", code: "23514" });
    for (const text of [...renderings(error), output()]) {
      expect(text).not.toContain(NOTE);
      expect(text).not.toContain(CONTACT);
      expect(text).not.toContain(ACCOUNT);
      expect(text).not.toContain("Ruth");
      expect(text).not.toContain("params");
      expect(text).not.toContain("insert into");
    }
    // The original is kept for a debugger, and it really did carry the note.
    expect(String((originalDatabaseError(error as DatabaseError) as Error).message)).toContain(NOTE);
  });

  it("a failing read is replaced the same way, keeping only a safe code", async () => {
    const db = await testDb();
    const error = await db.execute(sql`select ${"secret-param"}::int`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toMatch(/^[0-9A-Z]{5}$|^unknown$/);
    for (const text of renderings(error)) expect(text).not.toContain("secret-param");
  });
});
