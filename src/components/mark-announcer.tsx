"use client";

import { createContext, useContext, useState } from "react";

const Announce = createContext<(message: string) => void>(() => {});

/**
 * One polite live region for a whole list of dates. A row that is marked done moves
 * to another group (and its own markup is replaced), so the result is announced
 * from here, above the rows.
 */
export function MarkAnnouncer({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState("");
  return (
    <Announce value={setMessage}>
      {children}
      <p role="status" aria-live="polite" className="sr-only">
        {message}
      </p>
    </Announce>
  );
}

export function useAnnounce(): (message: string) => void {
  return useContext(Announce);
}
