# Agent brief — CRC Care

Read `PRODUCT.md` first. It is the confirmed product context; do not reopen its decisions.

## Stack
Follow the conventions of Daniel's Beit Mitzvah app (a sibling checkout at `../bneimitzvah`, where present) (read its `package.json`, `src/lib` auth setup and its MCP connector route for the pattern; do not copy its product code):
- Next.js App Router (current 16.x), React 19, TypeScript strict, Tailwind.
- Drizzle ORM on Neon Postgres (`@neondatabase/serverless`).
- better-auth with Google sign-in and its OAuth/MCP support for the connector.
- Vitest for tests.

## Rules
- Salesforce is read-only. The Salesforce client exposes query only; there is no write helper to misuse.
- Never print or commit secrets. `.env*` is ignored. Tests use an in-memory or throwaway database, never a real connection string.
- Phone first: design at 390px wide, then scale up. Light theme by default. No bottom tab bar; a left drawer and a bottom action bar.
- Pastoral note text never goes to logs, emails or analytics.
- Small files, one job each. No abstraction until the second use.
- Before pushing: `npx tsc --noEmit`, lint, and the tests you touched. CI runs everything.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Push the branch, open the PR, then stop. Do not merge or deploy.
- Report in under 15 lines: PR URL, what works, what is stubbed, open questions for the lead.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
