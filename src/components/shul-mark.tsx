import { DEMO_GOLD } from "@/lib/brand";

/**
 * The invented congregation's logo, for the demo build only: a house (beit) whose door is the
 * letter bet, with an asterisk over the roof, because the whole place is an example (dugma).
 * Drawn as paths so it needs no font or image file, and it works inside the generated app icon.
 * The house takes the text colour around it; the asterisk is always the demo's gold.
 */
export function ShulMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} style={{ flexShrink: 0 }}>
      {/* The house. */}
      <path d="M7 23 24 9l17 14v17a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      {/* The letter bet, standing in the doorway. */}
      <path d="M17 24h10a3 3 0 0 1 3 3v8M15.5 35.5h17" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      {/* The asterisk: see the footnote. */}
      <path d="M38 3v9M34.1 5.25l7.8 4.5M41.9 5.25l-7.8 4.5" stroke={DEMO_GOLD} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
