import { appendFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { markInsideTest } from "./db";

// Tells the test database helper which databases belong to one test; see tests/support/db.ts.
// No test may send email or reach the network: email is off, and the global fetch throws unless a test stubs its own.
beforeEach(() => {
  markInsideTest(true);
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("CARE_EMAIL", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubGlobal("fetch", () => {
    throw new Error("network is not allowed in tests");
  });
});
afterEach(() => markInsideTest(false));
afterAll(() => {
  if (process.env.TEST_RSS_LOG) appendFileSync(process.env.TEST_RSS_LOG, `${Math.round(process.memoryUsage().rss / 1048576)} ${expect.getState().testPath?.split(/[\\/]/).pop()}\n`);
});
