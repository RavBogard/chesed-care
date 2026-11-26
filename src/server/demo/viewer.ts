import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { DEMO_COOKIE, demoEmail, demoPersona } from "@/lib/demo";
import { viewerFor, type ViewerState } from "@/server/auth/viewer";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { DEMO_GATE_COOKIE, demoGateOpen } from "./gate";
import { ensureDemoFresh } from "./reset";

/**
 * Who a demo visitor is being: the persona their cookie names, when that demo account exists.
 * There is no sign-in. An account is never created here: the accounts exist only in a database
 * the reset has prepared, so a demo build pointed at any other database lets nobody in.
 */
export async function getDemoViewer(): Promise<ViewerState> {
  const jar = await cookies();
  const persona = demoPersona(jar.get(DEMO_COOKIE)?.value);
  // With an access code set, a visitor who has not typed it is nobody yet.
  if (!persona || !demoGateOpen(jar.get(DEMO_GATE_COOKIE)?.value)) return { kind: "signed-out" };
  const db = getDb();
  await ensureDemoFresh(db);
  const email = demoEmail(persona.key);
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!row) return { kind: "signed-out" };
  return viewerFor({ email, name: persona.name });
}
