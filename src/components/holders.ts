import { canHoldRestricted } from "@/server/access/policy";

/** Who can hold restricted care (active clergy level), as choices for a picker: an id and the name to show. */
export function holdersOf<M extends Parameters<typeof canHoldRestricted>[0] & { id: string; name: string | null; email: string }>(team: M[]): { id: string; name: string }[] {
  return team.filter(canHoldRestricted).map((m) => ({ id: m.id, name: m.name ?? m.email }));
}
