import { noticeClass } from "./ui";

/** The one sentence for something that could not be read: the page stays up and says what is missing. */
export function LoadNotice({ what, className }: { what: string; className?: string }) {
  return <p className={className ? `${noticeClass} ${className}` : noticeClass}>{`${what} could not be loaded just now. Try again in a minute.`}</p>;
}
