/** The check that marks a chosen filter or a finished row, so neither relies on colour alone. Decorative: the words beside it say it. */
export function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}
