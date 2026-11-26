/**
 * "Told to us by": for a proposal from the public form that was accepted, whose sender gave an email AND answered yes to
 * "May we tell them you let us know?". Accepting a proposal clears the details the sender stated (the intake: who it is about, their name and contact; proposals.ts keeps only the words); this keeps only the
 * sender's own name and email, with no timer (Daniel, 2026-11-25: "Keep everything"), so a clergy member can thank them from
 * their OWN mail app and the rabbis can reach them again.
 * Nothing is sent by this app. The line is shown only to those who fully see the accepted care item (careItemVisibleWhere,
 * so a restricted item's line exists only for those with access).
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { canSeeReporterLine, careItemVisibleWhere, type Actor } from "@/server/access/policy";
import { careItems, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { storedIntake } from "./intake";

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

type Row = typeof proposals.$inferSelect;

/** What to keep from a proposal being accepted: the sender's name and email, only for a public-form yes with an email. Pure. */
export function reporterToKeep(row: Pick<Row, "channel" | "mayTellThem" | "intake">): { reporterName: string; reporterEmail: string } | null {
  if (row.channel !== "form" || row.mayTellThem !== "yes") return null;
  const intake = storedIntake(row.intake);
  if (intake?.kind !== "public_form") return null;
  const email = intake.contact.trim();
  const name = intake.sender.trim();
  return EMAIL.test(email) && name ? { reporterName: name, reporterEmail: email } : null;
}

export type ReporterLine = { name: string; email: string };

/** The sender line for each of these care items the actor fully sees. Clergy level only. */
export async function getReporterLines(db: Db, actor: Actor, careItemIds: string[]): Promise<Map<string, ReporterLine>> {
  const out = new Map<string, ReporterLine>();
  if (careItemIds.length === 0 || !canSeeReporterLine(actor)) return out;
  const rows = await db
    .select({ itemId: careItems.id, name: proposals.reporterName, email: proposals.reporterEmail })
    .from(proposals)
    .innerJoin(careItems, eq(careItems.id, proposals.resultCareItemId))
    .where(and(inArray(careItems.id, careItemIds), eq(proposals.status, "accepted"), eq(proposals.mayTellThem, "yes"), isNotNull(proposals.reporterEmail), isNotNull(proposals.reporterName), careItemVisibleWhere(actor)));
  for (const r of rows) if (r.name && r.email) out.set(r.itemId, { name: r.name, email: r.email });
  return out;
}
