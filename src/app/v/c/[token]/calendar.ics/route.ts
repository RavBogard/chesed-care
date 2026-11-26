import { getDb } from "@/server/db/client";
import { claimIcs } from "@/server/volunteers/public";

export const dynamic = "force-dynamic";

/** A volunteer's task as a calendar file, by their own link. It holds the kind, the label, the date, the window and the place, and nothing else. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ics = await claimIcs(getDb(), token);
  if (!ics) return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="volunteering.ics"',
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
