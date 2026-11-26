// Brings the old Mitzvah Corps spreadsheet into the roster. A thin wrapper: the work is in src/server/volunteers/import.
//
//   npm run roster:import -- <file.json>            dry run: counts only, nothing written
//   npm run roster:import -- <file.json> --sample   also prints the first five people, for a person to check
//   npm run roster:import -- <file.json> --apply    writes, then one audit row of counts
//
// The file is { "tabs": { "<tab name>": [[cells]] } } as the Google Sheets values API gives it. Keep it out of the repo.
// Connects with DATABASE_MIGRATION_URL over Neon's HTTPS driver (no port 5432). Without it a dry run reads the file
// only. BETTER_AUTH_SECRET must be the app's, to recognise people who asked to stop: it is checked against the stored
// stopped contacts before anything is matched, and the run stops if it cannot be verified. Never prints the URL, the
// secret or a driver error. Sends no email and no push: everyone it adds is "imported, not yet asked".
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "../src/server/db/index";
import { installDatabaseErrorGuard } from "../src/server/db/errors";
import type { Db } from "../src/server/db/types";
import { previewFile, runRosterImport, type Runner } from "../src/server/volunteers/import/run";
import { summaryLines } from "../src/server/volunteers/import/report";
import { SecretUnverified } from "../src/server/volunteers/import/secret-check";
import { ImportBusy } from "../src/server/volunteers/import/lock";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  const sample = args.includes("--sample");
  if (!path || args.some((a) => a.startsWith("--") && a !== "--apply" && a !== "--sample")) {
    console.error("Usage: tsx scripts/roster-import.ts <file.json> [--sample] [--apply]");
    return 2;
  }
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error("Could not read that file as JSON.");
    return 2;
  }
  const url = process.env.DATABASE_MIGRATION_URL?.trim();
  if (!url) {
    if (apply) {
      console.error("DATABASE_MIGRATION_URL is not set; nothing was written.");
      return 2;
    }
    console.log(summaryLines(previewFile(file, sample)).join("\n"));
    console.log("No database given (DATABASE_MIGRATION_URL): new, updated and skipped are not counted.");
    return 0;
  }
  if (!process.env.BETTER_AUTH_SECRET) {
    console.error("BETTER_AUTH_SECRET is not set: it is needed to recognise people who asked to stop. Nothing was read or written.");
    return 2;
  }
  installDatabaseErrorGuard();
  const neonDb = drizzle(neon(url), { schema, logger: false });
  // One HTTP request per batch, run as one transaction: neon-http has no interactive transactions.
  const run: Runner = async (statements) => {
    if (statements.length) await neonDb.batch(statements as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]]);
  };
  try {
    const summary = await runRosterImport(neonDb as unknown as Db, file, { apply, sample, run });
    console.log(summaryLines(summary).join("\n"));
    return 0;
  } catch (error) {
    // The secret check's own words are safe to show (they never hold the secret); any other error, its class only.
    if (error instanceof SecretUnverified || error instanceof ImportBusy) {
      console.error(error.message);
      return 3;
    }
    throw error;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // The error's class only: a message could carry the URL or a row's values.
    console.error("Roster import failed:", error instanceof Error ? error.name : "unknown");
    process.exitCode = 1;
  },
);
