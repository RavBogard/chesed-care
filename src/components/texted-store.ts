"use client";

import { useSyncExternalStore } from "react";

/**
 * "I tapped Text for this one": remembered in this browser tab only (sessionStorage),
 * so the row can say so when the user comes back from Messages. Nothing is sent to
 * the server; the key is the occasion and its year, never a name or a number.
 */
const memory = new Set<string>();
const listeners = new Set<() => void>();

function read(key: string): boolean {
  if (memory.has(key)) return true;
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("pageshow", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("pageshow", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export function markTexted(key: string): void {
  memory.add(key);
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Private mode or blocked storage: the in-memory copy still serves this page.
  }
  for (const l of listeners) l();
}

export function useTexted(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => false,
  );
}
