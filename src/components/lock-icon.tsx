/** A padlock in the same single line weight as the kind icons: the mark of a restricted care item. */
export function LockIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`size-4 shrink-0 ${className}`}>
      <rect x="5" y="11" width="14" height="9.5" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
