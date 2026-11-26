# Chesed

A pastoral care app for clergy, made to be used on a phone between other things. It does two jobs: it shows whose yahrzeit, shloshim, birthday or anniversary is today so you can text them, and it keeps track of who needs care, who has them, and what is due.

A project of Rabbi Daniel Bogard, built for the clergy of Central Reform Congregation in St. Louis and shared so other congregations can use it.

- **Try it:** https://beit-dugma-care.vercel.app/demo (an invented congregation; nothing you do there reaches a real person).
- **Make it your own:** give [`docs/MAKE-IT-YOURS.md`](docs/MAKE-IT-YOURS.md) to your own Claude or ChatGPT. It is written for an assistant helping someone who is not a programmer.
- **Share what you build:** see [`CONTRIBUTING.md`](CONTRIBUTING.md). A connection to ShulCloud or another membership system is the most useful thing anyone could add.

## What to know before you start

- It was built for one congregation and is shared as it is. There is no setup wizard and no support.
- Member data (names, phone numbers, birthdays, yahrzeits) is read from the congregation's own membership system and never written back. Today the only real connection is to Salesforce. For anything else you build a small stand-in; the guide explains how.
- This repository is written automatically from the congregation's working copy each time that changes, so it is always the code they are running. The history here is one commit per update.

## For developers

- Next.js (App Router), React, TypeScript, Tailwind, Drizzle on Postgres (Neon), better-auth with Google sign-in, Vitest.
- `npm run lint`, `npm run typecheck`, `npm test` (an in-memory database; never a real one), `npm run build`.
- Database: `npm run db:migrate` applies the migrations; the build never does.
- Environment variables: `.env.example`. The demo build: `docs/DEMO.md`.
- Product decisions: `PRODUCT.md`. Access and privacy rules live in one module: `src/server/access/policy.ts`.
- A Claude connector (`<your address>/api/mcp`) lets a signed-in rabbi ask Claude "who needs me today?"; every tool acts as that person with exactly their access.

## Licence

MIT (see `LICENSE`). One dependency, `@hebcal/core` (the Hebrew calendar), is under the GPL, version 2 or later; if you distribute a built copy of the app, that licence's terms apply to the combined work.
