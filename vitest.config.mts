import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React server bundle; tests import server modules directly.
      "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/support/setup.ts"],
    // Tests never reach a real database: they use in-memory PGlite. Blank the
    // connection variables so nothing can fall back to one.
    env: { DATABASE_URL: "", DATABASE_MIGRATION_URL: "" },
    testTimeout: 30_000,
    // Hooks load an in-memory database; the default 10s is too tight on CI.
    hookTimeout: 30_000,
    // One database per file (tests/support/db.ts) keeps a worker well under 1 GB, so four fit a CI runner.
    maxWorkers: 4,
  },
});
