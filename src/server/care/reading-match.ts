/**
 * The matching step of the Inbox's AI reading. No model is involved and nothing it
 * finds is stored: it runs when the Inbox is drawn, for that viewer, through the
 * same read-only searches the Find screen uses (Salesforce people, and outside people
 * the viewer may see). A person the viewer cannot see is simply not found, and a
 * viewer who may not see the Inbox gets nothing at all.
 *
 * Names are searched only ever as written in the message; the model never sees any
 * directory. The text of a name is never logged.
 */
import { canManageOutsidePeople, canSeeLifecycle, type Actor } from "@/server/access/policy";
import { findPeopleCapped, FIND_LIMIT } from "@/server/lifecycle/find-people";
import type { SalesforceClient } from "@/server/salesforce/client";
import type { Db } from "@/server/db/types";
import { isStrongMatch, nameTokens, splitNames, variantsOf } from "./name-match";
import { searchOutsidePeople } from "./outside-people";

export type MatchedPerson = { kind: "sf"; contactId: string; name: string; household: string | null; place: string | null } | { kind: "outside"; id: string; name: string; note: string | null };

/** one: exactly one strong match. ambiguous: several (up to MAX_CANDIDATES to choose from). none: nobody found. */
export type NameMatch = { name: string; state: "one" | "ambiguous" | "none"; chosen: MatchedPerson | null; candidates: MatchedPerson[] };

export const MAX_CANDIDATES = 5;
/** Names looked up for one proposal when matching a whole list. */
export const LIST_MAX_NAMES = 3;
const MAX_NAMES = 6;
/** Lookups running at once while one page is drawn. */
export const LOOKUP_CONCURRENCY = 4;

type Deps = { db: Db; sf: () => SalesforceClient };

/**
 * A matcher for one viewer and one page draw. The same written name is looked up once
 * (the answer is remembered), and no more than `concurrency` lookups run at a time, so a
 * long Inbox cannot make an unbounded number of Salesforce and database queries.
 */
export function createMatcher(deps: Deps, actor: Actor, opts: { maxNames?: number; concurrency?: number } = {}) {
  const maxNames = opts.maxNames ?? MAX_NAMES;
  const limit = opts.concurrency ?? LOOKUP_CONCURRENCY;
  const memo = new Map<string, Promise<NameMatch>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    // A freed slot is handed straight to the next waiter (running stays as it is), so a caller
    // arriving in between can never take it and push the count past the limit.
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
  return async (written: readonly string[]): Promise<NameMatch[]> => {
    if (!canSeeLifecycle(actor) || !canManageOutsidePeople(actor)) return [];
    const names = [...new Set(written.flatMap(splitNames))].slice(0, maxNames);
    return Promise.all(
      names.map((name) => {
        const key = nameTokens(name).join(" ");
        let found = memo.get(key);
        if (!found) {
          found = slot(() => matchOne(deps, actor, name));
          memo.set(key, found);
        }
        // The same person written two ways keeps the words this proposal used.
        return found.then((m) => ({ ...m, name }));
      }),
    );
  };
}

/** The people named in what was written, each looked up for this viewer. */
export async function matchNames(deps: Deps, actor: Actor, written: readonly string[]): Promise<NameMatch[]> {
  return createMatcher(deps, actor)(written);
}

async function matchOne(deps: Deps, actor: Actor, name: string): Promise<NameMatch> {
  const tokens = nameTokens(name);
  const none: NameMatch = { name, state: "none", chosen: null, candidates: [] };
  if (tokens.length === 0 || tokens.length > 4) return none;
  const found = new Map<string, MatchedPerson>();
  // A search that came back full may have left people out, so it can never settle on one person.
  let capped = false;

  // Salesforce people: one query per first-name spelling (a handful at most), each with the surname.
  const first = tokens[0];
  const rest = tokens.slice(1);
  const allSpellings = tokens.length === 1 ? [first] : variantsOf(first);
  const spellings = allSpellings.slice(0, 4);
  // Spellings left unsearched mean the search may have missed people: it can never settle on one.
  capped ||= allSpellings.length > spellings.length;
  for (const spelling of spellings) {
    try {
      const result = await findPeopleCapped({ sf: deps.sf }, actor, [spelling, ...rest].join(" "));
      capped ||= result.capped;
      for (const p of result.people) {
        if (isStrongMatch(tokens, p.name)) found.set(`sf:${p.contactId}`, { kind: "sf", contactId: p.contactId, name: p.name, household: p.household, place: p.place });
      }
    } catch {
      // Salesforce down or a word the search refuses: this name is simply not matched there.
    }
  }

  // Outside people the viewer may see (never one only a restricted item is about).
  try {
    const probe = tokens[tokens.length - 1];
    if (probe.length >= 2) {
      const people = await searchOutsidePeople(deps.db, actor, probe);
      capped ||= people.length >= FIND_LIMIT;
      for (const o of people) {
        if (!isStrongMatch(tokens, o.name)) continue;
        // An outside person already linked to a Salesforce person is that person, not a second one.
        if (o.linkedSfContactId && found.has(`sf:${o.linkedSfContactId}`)) continue;
        found.set(`outside:${o.id}`, { kind: "outside", id: o.id, name: o.name, note: o.note });
      }
    }
  } catch {
    // Not searchable for this viewer: nobody found there.
  }

  const all = [...found.values()];
  if (all.length === 0) return none;
  // One name alone ("Ruth") or an incomplete search never picks a person: the clergy choose.
  if (all.length === 1 && tokens.length > 1 && !capped) return { name, state: "one", chosen: all[0], candidates: [] };
  return { name, state: "ambiguous", chosen: null, candidates: all.slice(0, MAX_CANDIDATES) };
}
