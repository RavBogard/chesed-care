import "server-only";
import { revalidatePath } from "next/cache";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { InvalidInput, NotFound, TooMany } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import type { Db } from "@/server/db/types";
import type { ActionState } from "@/lib/action-state";
import type { ViewerState } from "./session";

export type { ActionState };

/** Form values as plain strings; a missing field is undefined (the server functions validate). */
export function fields(form: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

/** Errors become calm messages (never the input, which may be pastoral text). */
function calm(error: unknown): string {
  if (error instanceof AccessDenied) return "You do not have access to do that.";
  if (error instanceof InvalidInput) return "Please check what you entered and try again.";
  if (error instanceof TooMany) return "That is enough for now. Try again in a while.";
  if (error instanceof NotFound) return "That could not be found. It may have been closed or moved.";
  console.error("Action failed", error instanceof Error ? error.name : "unknown");
  return "Something went wrong. Please try again.";
}

export type DataState<T> = { status: "ok"; data: T } | { status: "error"; message: string };

/** Like runAction, for an action that hands data back to the screen (a new proposal's id, the people found). Nothing is revalidated. */
export async function runData<T>(viewer: ViewerState, op: (actor: Actor, db: Db) => Promise<T>): Promise<DataState<T>> {
  if (viewer.kind !== "ok") return { status: "error", message: "Please sign in again." };
  try {
    return { status: "ok", data: await op(viewer.actor, getDb()) };
  } catch (error) {
    return { status: "error", message: calm(error) };
  }
}

/**
 * Run a server action for the resolved viewer. A signed-out or not-authorised viewer
 * is refused before anything runs; every data function then checks the actor itself.
 */
export async function runAction(viewer: ViewerState, op: (actor: Actor, db: Db) => Promise<string>): Promise<ActionState> {
  if (viewer.kind !== "ok") return { status: "error", message: "Please sign in again." };
  try {
    const message = await op(viewer.actor, getDb());
    revalidatePath("/", "layout");
    return { status: "ok", message };
  } catch (error) {
    return { status: "error", message: calm(error) };
  }
}
