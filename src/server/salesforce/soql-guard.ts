/**
 * The read-only gate in front of every Salesforce request: exactly one SELECT
 * statement, with no clause that writes (FOR VIEW / FOR REFERENCE update a
 * record's "last viewed" fields; FOR UPDATE locks; UPDATE TRACKING/VIEWSTAT write).
 */
export class RefusedQuery extends Error {
  constructor(reason: string) {
    super(`Refused SOQL: ${reason}`);
    this.name = "RefusedQuery";
  }
}

const WRITING_CLAUSES = /\bFOR\s+(?:VIEW|REFERENCE|UPDATE)\b|\bUPDATE\s+(?:TRACKING|VIEWSTAT)\b/i;
const DML_WORDS = /^\s*(?:INSERT|UPDATE|UPSERT|DELETE|UNDELETE|MERGE)\b/i;

/** Remove quoted string literals so their contents cannot trip (or hide from) the checks. */
function withoutLiterals(soql: string): string {
  return soql.replace(/'(?:\\.|[^'\\])*'/g, "''");
}

export function assertReadOnlySoql(soql: unknown): string {
  if (typeof soql !== "string") throw new RefusedQuery("not a string");
  const q = soql.trim();
  if (!q) throw new RefusedQuery("empty");
  if (q.length > 100_000) throw new RefusedQuery("too long");
  if (DML_WORDS.test(q)) throw new RefusedQuery("not a SELECT");
  if (!/^SELECT\s/i.test(q)) throw new RefusedQuery("not a SELECT");
  const bare = withoutLiterals(q);
  if (/'/.test(bare.replace(/''/g, ""))) throw new RefusedQuery("unbalanced quote");
  if (bare.includes(";")) throw new RefusedQuery("more than one statement");
  if (WRITING_CLAUSES.test(bare)) throw new RefusedQuery("writing clause");
  return q;
}
