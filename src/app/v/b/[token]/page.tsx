import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicFrame } from "@/components/meals/parts";
import { whenWords } from "@/components/volunteers/parts";
import { publicMetadata } from "@/components/public-meta";
import { KIND_WORDS, placesWords, PREVIEW_TITLE } from "@/lib/volunteers-wording";
import { getDb } from "@/server/db/client";
import { getPublicBoard } from "@/server/volunteers/public";

export const dynamic = "force-dynamic";
export const metadata = publicMetadata(PREVIEW_TITLE);

/** One poster's open tasks on one page, to send to a list or a group text: what, for whom, when, and the places left. Nothing else. */
export default async function PublicBoardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const board = await getPublicBoard(getDb(), token);
  if (!board) notFound();
  return (
    <PublicFrame congregation={board.congregation} title="Ways to help">
      {board.items.length === 0 ? (
        <p className="mt-4 text-lg" data-testid="board-empty">
          Nothing needs help just now. Thank you for asking.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3" data-testid="board">
          {board.items.map((i) => (
            <li key={i.href + i.date} data-testid="board-item">
              <Link href={i.href} className="block min-h-11 rounded-md border-2 border-action bg-surface px-4 py-3 transition-colors hover:bg-tint">
                <span className="block font-serif text-lg font-bold underline decoration-control underline-offset-4">
                  {KIND_WORDS[i.kind]} for {i.forLabel}
                </span>
                <span className="block text-base">{whenWords(i.date, i.timeWindow)}</span>
                <span className="block text-base font-semibold text-action">{placesWords(i.placesLeft)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PublicFrame>
  );
}
