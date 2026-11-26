import { users } from "./schema";

/**
 * The columns that decide who may sign in. Reads and writes that resolve an actor name these
 * columns and never `select()` the whole row, so a column added later (today_prefs) can never
 * break sign-in for everyone if the code is deployed before its migration has run.
 */
export const userColumns = { id: users.id, email: users.email, name: users.name, role: users.role, active: users.active, summaryPref: users.summaryPref, createdAt: users.createdAt, updatedAt: users.updatedAt };
