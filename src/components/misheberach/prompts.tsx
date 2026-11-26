import { PROMPT_TITLE, promptLine } from "@/lib/misheberach-wording";
import type { Prompt } from "@/server/misheberach/list";
import { cardClass } from "../ui";
import { RenewButtons } from "./entry-forms";
import { SpokenName } from "./entry-list";

/** The quiet "still needed?" prompts: dated names that come off within a week, each with its three one-tap answers. */
export function MiPrompts({ prompts }: { prompts: Prompt[] }) {
  if (prompts.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-3" aria-label={PROMPT_TITLE} data-testid="mi-prompts">
      {prompts.map((p) => (
        <li key={p.id} className={cardClass} data-testid="mi-prompt">
          <p className="text-base">
            <SpokenName className="font-serif font-semibold">{p.name}</SpokenName>
          </p>
          <p className="mb-2 text-sm text-rubric">{promptLine(p.expiresOn)}</p>
          <RenewButtons id={p.id} name={p.name} />
        </li>
      ))}
    </ul>
  );
}
