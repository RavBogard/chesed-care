import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PRODUCT.md: no giving or financial data, ever. Every string literal in the
 * Salesforce and lifecycle code (the SOQL and the field lists spliced into it)
 * is scanned for the giving objects and fields.
 */
const DIRS = ["src/server/salesforce", "src/server/lifecycle"];
// npo02__ is NPSP's household rollup namespace (giving totals, last gift, ...);
// only these non-financial household fields are allowed from it.
const NPO02_ALLOWED = new Set(["npo02__Formal_Greeting__c", "npo02__Informal_Greeting__c"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/** String literal bodies ('...', "...", `...`) with comments removed first. */
function stringLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [...code.matchAll(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g)].map((m) => m[0]);
}

function givingViolations(literal: string): string[] {
  const found: string[] = [];
  if (/\bOpportunit(y|ies)\b/i.test(literal)) found.push("Opportunity");
  if (/npe01__OppPayment__c/i.test(literal)) found.push("npe01__OppPayment__c");
  if (/npsp__Allocation__c/i.test(literal)) found.push("npsp__Allocation__c");
  for (const [word] of literal.matchAll(/[A-Za-z0-9_]*(Amount|Gift|Donation)[A-Za-z0-9_]*/gi)) found.push(word);
  for (const [field] of literal.matchAll(/npo02__[A-Za-z0-9_]+/g)) if (!NPO02_ALLOWED.has(field)) found.push(field);
  return found;
}

describe("guard: no giving data in Salesforce queries", () => {
  it("the scanner catches each forbidden kind of name", () => {
    for (const bad of [
      "SELECT Id FROM Opportunity",
      "SELECT Id, (SELECT Id FROM Opportunities) FROM Account",
      "SELECT Id FROM npe01__OppPayment__c",
      "SELECT Id FROM npsp__Allocation__c",
      "SELECT Amount FROM X",
      "SELECT Largest_Gift__c FROM Account",
      "SELECT Last_Donation_Date__c FROM Contact",
      "SELECT npo02__TotalOppAmount__c FROM Account",
      "SELECT npo02__LastCloseDate__c FROM Account",
    ])
      expect(givingViolations(bad), bad).not.toEqual([]);
    expect(givingViolations("SELECT npo02__Formal_Greeting__c, Name FROM Account")).toEqual([]);
  });

  it("no SOQL string under src/server/salesforce or src/server/lifecycle names giving data", () => {
    const files = DIRS.flatMap(tsFiles);
    expect(files.length).toBeGreaterThan(5);
    const violations = files.flatMap((f) => stringLiterals(readFileSync(f, "utf8")).flatMap((lit) => givingViolations(lit).map((v) => `${f}: ${v}`)));
    expect(violations).toEqual([]);
  });
});
