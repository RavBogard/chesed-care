import { getDb } from "@/server/db/client";
import { mealSignupIcs } from "@/server/meals/public";

export const dynamic = "force-dynamic";

/** A helper's night as a calendar file, by their own link. It holds the date, window and address and nothing about the family's needs. */
export async function GET(_request: Request, { params }: { params: Promise<{ manageToken: string }> }) {
  const { manageToken } = await params;
  const ics = await mealSignupIcs(getDb(), manageToken);
  if (!ics) return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mitzvah-meals.ics"',
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
