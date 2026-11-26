import Link from "next/link";
import { PrintButton } from "@/components/print-button";
import { QrCode } from "@/components/meals/qr";
import { noticeClass } from "@/components/ui";
import { CONGREGATION } from "@/server/meals/core";

/**
 * A page to print: the congregation, a heading, a short plain invitation (and any lines the
 * public page already shows), a QR code and the link in words. On screen it has a Print
 * button; on paper only the flyer. With no link there is nothing to print, so it says why.
 */
export function Flyer({
  backHref,
  backLabel,
  heading,
  invitation,
  details = [],
  url,
  qrLabel,
  noLinkMessage,
  urlTestId = "flyer-url",
}: {
  backHref: string;
  backLabel: string;
  heading: string;
  invitation: string;
  /** Lines the public page shows before a claim (never a place or a contact line). */
  details?: string[];
  url: string | null;
  qrLabel: string;
  noLinkMessage: string;
  /** The test id of the link in words, where a page already had its own. */
  urlTestId?: string;
}) {
  return (
    <div className="min-h-dvh bg-ground print:bg-transparent">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-3 print:hidden">
        <Link href={backHref} className="inline-flex min-h-11 items-center text-sm font-medium text-action underline underline-offset-4">
          {backLabel}
        </Link>
        {url ? <PrintButton /> : null}
      </div>
      <main id="main" className="mx-auto max-w-xl px-6 pb-10 pt-4 text-center print:max-w-none print:pt-12">
        {url ? (
          <article className="flex flex-col items-center gap-6 rounded-md border border-rule bg-surface px-6 py-10 print:border-0 print:bg-transparent">
            <p className="font-serif text-xl font-bold">{CONGREGATION}</p>
            <h1 className="font-serif text-4xl font-bold leading-tight text-balance print:text-5xl">{heading}</h1>
            <p className="max-w-prose whitespace-pre-line text-xl">{invitation}</p>
            {details.map((line) => (
              <p key={line} className="max-w-prose break-words text-xl font-semibold">
                {line}
              </p>
            ))}
            <QrCode text={url} label={qrLabel} className="w-64 max-w-full print:w-96" />
            <p className="break-all text-lg font-semibold" data-testid={urlTestId}>
              {url}
            </p>
          </article>
        ) : (
          <p className={noticeClass}>{noLinkMessage}</p>
        )}
      </main>
    </div>
  );
}
