import { PublicFrame } from "@/components/meals/parts";
import { CONGREGATION } from "@/server/meals/core";

/** An unknown, mistyped or purged public link: one kind sentence, and nothing about whether anything ever existed. */
export function PublicNotFound({ title, message }: { title: string; message: string }) {
  return (
    <PublicFrame congregation={CONGREGATION} title={title}>
      <p className="mt-4 text-base">{message}</p>
    </PublicFrame>
  );
}
