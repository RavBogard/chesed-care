/**
 * "Load it, and if that fails show the page without it." A failed read must never break a page, and what is
 * logged is a fixed label and the error's NAME only, never its message: a message can quote pastoral text.
 */
import { appOrigin } from "@/server/env";

/** Logs that something could not be loaded: the fixed `label` and the error's name, nothing else. */
export function logFailure(label: string, error: unknown): void {
  console.error(label, error instanceof Error ? error.name : "unknown");
}

/** The result of `fn`, or `fallback` (logged under `label`) when it throws. */
export async function soft<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logFailure(label, error);
    return fallback;
  }
}

/** The app's own address, or null where it is not configured (local work without an origin): the page still shows, without a whole link. */
export function appOriginOrNull(): string | null {
  try {
    return appOrigin();
  } catch {
    return null;
  }
}
