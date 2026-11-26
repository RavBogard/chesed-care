/** Calm placeholder blocks shown while a page's data loads. */
export function ContentSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-3">
      <div className="skeleton h-4 w-40 max-w-full rounded-md bg-rule" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-24 rounded-md border border-rule bg-rule-soft" />
      ))}
    </div>
  );
}

/** A whole page that is still loading: the shell's navy bar (or rail) with the placeholder blocks where the content will be. */
export function PageSkeleton() {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div aria-hidden="true" className="h-14 bg-shell lg:h-dvh" />
      <div className="mx-auto w-full max-w-xl px-4 pt-5 lg:max-w-3xl lg:px-8 lg:pt-24">
        <ContentSkeleton />
      </div>
    </div>
  );
}
