import "server-only";
import { headers } from "next/headers";
import { isDemo } from "@/lib/demo";
import { getDemoViewer } from "@/server/demo/viewer";
import { getAuth } from "./index";
import { viewerFor, type ViewerState } from "./viewer";

export type { ViewerState };

/** Who is making this request: signed out, signed in but not on the allowlist, or an acting user. */
export async function getViewer(): Promise<ViewerState> {
  // The demo build has no sign-in: the visitor picks who to be (src/server/demo/viewer.ts).
  if (isDemo()) return getDemoViewer();
  const session = await getAuth().api.getSession({ headers: await headers() });
  return viewerFor(session ? { email: session.user.email, name: session.user.name } : null);
}
