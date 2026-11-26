"use client";

import { formatAddress, mapsUrl, type Address } from "@/lib/address";
import { useBriefMessage } from "./copy-button";
import { btnQuiet, cardClass } from "./ui";

/**
 * A person's address: two lines, one clear action to open it in Google Maps, and a quiet copy button.
 * Shows nothing when there is no address. Only ever given to someone who already sees phone numbers.
 */
export function AddressBlock({ address }: { address: Address | null }) {
  const [message, say] = useBriefMessage();
  if (!address) return null;
  const { lines, oneLine } = formatAddress(address);
  if (lines.length === 0) return null;
  const url = mapsUrl(address);
  return (
    <section aria-label="Address" data-testid="person-address" className={`${cardClass} mb-5 flex flex-wrap items-center justify-between gap-3`}>
      <p className="min-w-0 break-words text-base">
        {lines.map((l, i) => (
          <span key={i} className="block">
            {l}
          </span>
        ))}
      </p>
      <span className="flex flex-wrap items-center gap-2">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className={btnQuiet} data-testid="address-maps">
            Open in Google Maps<span className="sr-only">, opens in a new tab</span>
          </a>
        ) : null}
        <button
          type="button"
          className={btnQuiet}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(oneLine);
              say("Copied");
            } catch {
              say("Could not copy. Select the address to copy it by hand.");
            }
          }}
        >
          Copy address
        </button>
        <span role="status" aria-live="polite" className="text-sm font-medium text-done empty:hidden">
          {message}
        </span>
      </span>
    </section>
  );
}
