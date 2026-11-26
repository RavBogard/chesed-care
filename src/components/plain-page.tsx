import { Hebrew } from "./hebrew";
import { facingLine } from "./ui";

/**
 * The frame for a page outside the signed-in shell (sign-in, not authorised, the connector's
 * consent step, errors): the same navy bar with the page's one h1, and a narrow column beneath.
 * `facing` is the Hebrew that faces the title on the bar, as on Today (the Hebrew date).
 */
export function PlainPage({ title, facing, children }: { title: string; facing?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-shell text-on-shell">
        <div className="mx-auto flex min-h-14 w-full max-w-sm items-center px-6 py-2">
          <div className={`${facingLine} min-w-0 flex-1`}>
            <h1 className="min-w-0 break-words font-serif text-[1.375rem] font-bold leading-tight">{title}</h1>
            {facing ? (
              <Hebrew size="text-[1.375rem]" className="text-on-shell-muted">
                {facing}
              </Hebrew>
            ) : null}
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto flex w-full max-w-sm flex-col gap-5 px-6 py-8">
        {children}
      </main>
    </div>
  );
}
