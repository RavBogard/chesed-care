/**
 * The database error boundary. Drizzle 0.45 builds its query error message from
 * the SQL and every bound parameter ("Failed query: … params: …"), and Postgres
 * errors carry row values in `detail`. Either would put session tokens, emails or
 * pastoral note text into logs the moment an error is printed.
 *
 * installDatabaseErrorGuard() wraps the one method every drizzle Postgres query
 * runs through (PgPreparedQuery.queryWithCache; Neon at runtime, PGlite in tests,
 * transactions and better-auth's adapter included), so any failing query throws a
 * DatabaseError instead: a static message and a safe code (the SQLSTATE, or
 * "unknown"). The original error is kept out of reach of logging: not as `cause`
 * (Node's util.inspect, and so console.error, prints `cause` even when it is not
 * enumerable) but in a WeakMap, readable only through originalDatabaseError().
 */
import { PgPreparedQuery } from "drizzle-orm/pg-core";

const originals = new WeakMap<DatabaseError, unknown>();

export class DatabaseError extends Error {
  readonly code: string;
  constructor(code: string, original: unknown) {
    super("Database operation failed");
    this.name = "DatabaseError";
    this.code = code;
    originals.set(this, original);
  }
  toJSON() {
    return { name: this.name, message: this.message, code: this.code };
  }
}

/** The underlying driver error, for a debugger session only. Never log it. */
export function originalDatabaseError(error: DatabaseError): unknown {
  return originals.get(error);
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The SQLSTATE from the error or its cause chain; nothing else is copied. */
function safeCode(error: unknown): string {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return "unknown";
}

export function toDatabaseError(error: unknown): DatabaseError {
  return error instanceof DatabaseError ? error : new DatabaseError(safeCode(error), error);
}

const GUARD = Symbol.for("crc-care.database-error-guard");
type Guarded = { [GUARD]?: true; queryWithCache: (this: unknown, ...args: unknown[]) => Promise<unknown> };

/** Idempotent. Called by the database client module and by the test database. */
export function installDatabaseErrorGuard(): void {
  const proto = PgPreparedQuery.prototype as unknown as Guarded;
  if (proto[GUARD]) return;
  const original = proto.queryWithCache;
  if (typeof original !== "function") throw new Error("drizzle-orm changed: PgPreparedQuery.queryWithCache is missing");
  proto.queryWithCache = async function guardedQueryWithCache(this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (error) {
      throw toDatabaseError(error);
    }
  };
  proto[GUARD] = true;
}

export function isDatabaseErrorGuardInstalled(): boolean {
  return (PgPreparedQuery.prototype as unknown as Guarded)[GUARD] === true;
}
