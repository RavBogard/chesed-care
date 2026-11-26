import Link from "next/link";
import { btnQuiet, btnSelected } from "./ui";
import { CheckIcon } from "./check-icon";

/** A filter link. The chosen one is outlined and carries a check, so it never relies on colour alone. */
export function Chip({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={to} aria-current={active ? "true" : undefined} className={active ? `${btnSelected} gap-1.5` : btnQuiet}>
      {active ? (
        <CheckIcon />
      ) : null}
      {children}
    </Link>
  );
}
