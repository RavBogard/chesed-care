"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { DEMO_COOKIE, demoPersona, isDemo } from "@/lib/demo";
import { getDb } from "@/server/db/client";
import { DEMO_GATE_COOKIE, demoCodeMatches, demoGateOpen, demoGateToken } from "@/server/demo/gate";
import { ensureDemoFresh, resetDemo, START_OVER_GAP_MS } from "@/server/demo/reset";

const MONTH_SECONDS = 30 * 24 * 60 * 60;

const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: MONTH_SECONDS };

/** Back to the front page unless this visitor has typed the access code (or none is set). */
async function gateOrRedirect(): Promise<void> {
  if (!demoGateOpen((await cookies()).get(DEMO_GATE_COOKIE)?.value)) redirect("/demo");
}

/** A visitor types the access code. A wrong one waits a moment, so guessing is slow. */
export async function unlockDemo(form: FormData): Promise<void> {
  if (!isDemo()) notFound();
  const token = demoGateToken();
  if (!token || !demoCodeMatches(form.get("code"))) {
    await new Promise((done) => setTimeout(done, 700));
    redirect("/demo?code=wrong");
  }
  (await cookies()).set(DEMO_GATE_COOKIE, token, cookieOptions);
  redirect("/demo");
}

/** A visitor chooses who to be. The cookie holds the persona's key and nothing else. */
export async function enterDemo(form: FormData): Promise<void> {
  if (!isDemo()) notFound();
  await gateOrRedirect();
  const persona = demoPersona(form.get("persona"));
  if (!persona) redirect("/demo");
  await ensureDemoFresh(getDb());
  (await cookies()).set(DEMO_COOKIE, persona.key, cookieOptions);
  // Each role lands on its own home: the pages send a lead to Volunteers and the office to Report.
  redirect("/");
}

/** Put the starting story back now, for every visitor. */
export async function startDemoOver(): Promise<void> {
  if (!isDemo()) notFound();
  await gateOrRedirect();
  await resetDemo(getDb(), new Date(), { minGapMs: START_OVER_GAP_MS });
  revalidatePath("/", "layout");
  redirect("/demo?fresh=1");
}
