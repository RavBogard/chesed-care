# Sharing your changes

Chesed was built for one congregation and shared so others can make their own (see `docs/MAKE-IT-YOURS.md`). If you connected it to a membership system we do not support yet, such as ShulCloud, or fixed something, we would like to hear about it and, where it fits, include it.

## How

1. **Open an issue first.** Say what you built and for which system, and how it gets the data (an API, a scheduled export, a file). This lets us say early whether it fits, and tells other congregations it exists even if it is never merged.
2. **Then a pull request**, small enough to read in one sitting.

## What a pull request must not contain

A congregation's member list and pastoral notes are the most private things it holds. A pull request is public the moment it is opened, and deleting it later does not reliably remove it.

- No real person's name, phone number, email, address, date or note. Not in code, tests, comments, screenshots, commit messages or the description.
- No export files or database dumps, even "anonymised" ones.
- No keys, passwords, tokens or connection strings.
- No addresses of your own systems that are not already public.

Use invented people, as the demo does (`src/server/demo/congregation.ts`).

## What we look for

- A membership connection lives in its own folder, reads its settings from environment variables, and only ever reads. There is no way to write to the membership system, by design.
- It answers the same queries the demo's stand-in answers, and has a test like `tests/demo.test.ts` that runs every one of them through it.
- `npm run typecheck`, `npm run lint` and `npm test` pass.
- New packages are few, well known, and under a licence compatible with this one.

## What happens next

This repository is written automatically from the congregation's private working copy, so a pull request is never merged here directly: when a change is accepted it is brought into the working copy by hand, with credit to you in the commit, and appears here with the next update. Nothing is merged automatically. A person reads every line. Code from outside is treated as untrusted until it has been read: it is not run against a real database, and it is never given real credentials, before that. We may ask for changes, take the idea and write it differently, or say no. We are a congregation, not a software company, so an answer can take a few weeks.

By offering a change you agree it is shared under this repository's licence (`LICENSE`).
