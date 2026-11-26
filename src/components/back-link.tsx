"use client";

import { useRouter } from "next/navigation";
import { btnText } from "./ui";

/** Back to where the person was opened from (a search, a list); to `fallback` when the page was opened directly. */
export function BackLink({ fallback }: { fallback: string }) {
  const router = useRouter();
  return (
    <button type="button" className={`${btnText} -ml-1 mb-2 gap-1 px-1 no-underline hover:underline`} onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m15 6-6 6 6 6" />
      </svg>
      Back
    </button>
  );
}
