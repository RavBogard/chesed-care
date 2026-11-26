/**
 * Run a task after the response is sent, so a user's action never waits on a push or mail service.
 * Never throws; a failure logs the fixed `label` and the error's class, nothing else.
 */
import { after } from "next/server";

export function runAfterResponse(label: string, task: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await task();
    } catch (error) {
      console.error(label, error instanceof Error ? error.name : "unknown");
    }
  };
  try {
    after(run);
  } catch {
    // Not inside a request (a script or a test): there is nothing to schedule on.
  }
}
