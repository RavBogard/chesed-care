import { rubric } from "./ui";

export function Section({ title, children, empty }: { title: string; children?: React.ReactNode; empty?: string }) {
  return (
    <section className="mt-7 first:mt-0" aria-label={title}>
      <h2 className={rubric}>{title}</h2>
      {children ?? <p className="mt-2 text-sm text-rubric">{empty}</p>}
    </section>
  );
}
