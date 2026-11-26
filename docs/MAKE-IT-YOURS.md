# Make it your own

The app is called Chesed. This guide is written for an AI assistant (Claude, ChatGPT or another) helping someone set up their own copy of this app for their congregation. If you are that person, you can read along, but the easy way is to hand this page to your assistant.

## Who you are helping

A rabbi, cantor, executive director or volunteer at another congregation. Assume:

- They tried the demo at https://beit-dugma-care.vercel.app/demo and want the same thing with their own people in it.
- They are comfortable with Claude or ChatGPT. They are not a programmer.
- They have no GitHub account and have never heard of Vercel, Neon, Postgres, OAuth or environment variables. Say what each thing is in one plain sentence the first time it comes up ("Vercel is the company whose computers will run your copy").
- Their time comes in ten-minute pieces. Tell them where you are ("step 3 of 9") and what is left.

## How to work

- Ask one question at a time, and wait for the answer.
- Before any step that could cost money, say what it costs and wait for a yes.
- Never ask them to paste a password or secret key into the chat. When a secret is needed, tell them where to paste it (a settings page, or a file on their own computer) and never repeat it back.
- If you can run commands and edit files (Claude Code, Cowork, Codex and the like), do the work yourself and ask them only for decisions and for the clicks only they can make (creating accounts, approving sign-ins). If you are a chat-only assistant, say so at the start and recommend they open Claude Code (it is inside the Claude desktop app) and paste the same request there; if they would rather stay, walk them through every click.
- Read `PRODUCT.md`, `AGENTS.md`, `README.md`, `.env.example` and `docs/DEMO.md` in the repository before changing anything. They are short and they are the source of truth. If this guide and the code disagree, the code is right: say so and carry on.

## What this app is, honestly

It was built for one congregation, Central Reform Congregation in St. Louis, and shared as it is. It is not a product with a setup wizard, and nobody is offering support. Three things are specific to that congregation and are the real work of making a copy:

1. **Names and place.** The congregation's name, its addresses and its time zone (US Central) are written into the code.
2. **Where the members come from.** The app reads households, phone numbers, birthdays, anniversaries and yahrzeits from the congregation's Salesforce database, using that database's own field names. It only ever reads. Your congregation's membership system is almost certainly different.
3. **Who is allowed in.** Sign-in is by Google account, from a list the owners keep.

Everything the app itself records (the care list, follow-ups, the Inbox, volunteers, meals) lives in its own database and needs no changing.

## First, ask these

1. What is the congregation's full name, and the short name people use?
2. What city, and what time zone?
3. Who will be the owners (the one or two people who can add everyone else)? You need the Google address each will sign in with. Does the congregation use Google Workspace?
4. Where does the membership list live today: ShulCloud, Chaverware, Salesforce, another system, or a spreadsheet? Can they export it, and who at the congregation administers it?
5. Who will use it: how many clergy, is there a caring committee or volunteer lead, does the office report needs?
6. Do they want it at their own address (care.theirshul.org) or is a free address ending in vercel.app fine to start?
7. Is there a staff member or volunteer who is comfortable with technical things and should be in the room?

## The plan

Tell them the whole plan first, then go one step at a time.

### 1. Their own play copy (about an hour, no real data)

Do this first. It proves the accounts work before any real person's name is involved.

1. **GitHub account** (free). GitHub is where the code is kept. Then **fork** this repository: their own copy that they can change.
2. **Vercel account** (sign in with the GitHub account). Vercel runs the app. The free Hobby plan is meant for personal, non-commercial use; check Vercel's current terms with them and, if in doubt for a congregation, the Pro plan is a monthly fee per person on the team. Look up today's price rather than quoting from memory.
3. **A database.** In Vercel, add Neon Postgres from the Marketplace (Storage). Neon has a free tier that is enough for this. Create a new, empty database.
4. Follow `docs/DEMO.md` exactly: apply the migrations to the new database, create the Vercel project from their fork with only the variables listed there, deploy, open `/demo`.

They now have their own demo with the invented congregation. Let them show a colleague before going on.

### 2. Make it theirs

1. Names: `src/lib/brand.ts` holds the names on the screen. Then search the code for `centralreform`, `Central Reform`, `CRC` and `St. Louis` and decide each one with them (email addresses, the address the app redirects from in `src/server/security/old-host.ts`, wording on public pages).
2. Time zone: search for `America/Chicago` (the code, and the schedule in `vercel.json`) and change it if they are elsewhere. Dates of yahrzeits and "today" depend on it, so run the tests after.
3. Read `PRODUCT.md` with them for the decisions behind the app (who sees what, what "restricted" means). Change the roles and wording only where their congregation really differs.
4. Run `npm run typecheck`, `npm run lint` and `npm test`. The tests use an in-memory database and never touch a real one.

### 3. Their members

This is the hard part; say so. Most congregations keep their members in ShulCloud or a system like it (Chaverware, Rakefet, a spreadsheet), not in Salesforce. **This app does not have a ShulCloud connection yet.** One is planned, but today you and they will be building it, and they should know that before they start.

All member data comes through one small opening: `getSalesforce()` in `src/server/salesforce/index.ts`, which returns something with a single method, `query(soql)`. The demo fills that opening with an invented congregation (`src/server/demo/salesforce.ts` reading `src/server/demo/congregation.ts`), and `tests/demo.test.ts` runs every query the app makes through it. That gives three routes:

- **ShulCloud or another membership system.** Write a new stand-in modelled on the demo's: it answers the same queries from their data. First find out, from the vendor's own current documentation or support, what their plan actually offers: an API, scheduled exports, or only manual exports. Do not guess at an API. Start from a file exported by hand and kept out of the repository; move to the API or a scheduled export once the app is proving useful.
- **A spreadsheet.** The same as the export route. It is fine to start here.
- **They use Salesforce.** Map the field names the app asks for (see the queries under `src/server/lifecycle`) to theirs, set up a read-only connected app, and fill in the `SF_JWT_*` variables from `.env.example`. Their Salesforce administrator has to be involved.

Whichever route: the app must never write to the membership system, real members' data must never be committed to GitHub (make their copy private before real data is anywhere near it), and the test that runs every query through the stand-in must pass, using invented people.

Build the connection so another congregation could use it: in its own folder, taking its settings from environment variables, with nothing about this one congregation written into it.

### Sharing what you built

If the connection works, other congregations on the same system need exactly that, and the people who made this app would like to include it. Offer this once it is working, and do it only if they say yes. See `CONTRIBUTING.md` for the rules; in short:

1. Tell us first: open an issue at https://github.com/RavBogard/chesed-care, saying which system you connected and how (API, export, spreadsheet).
2. Then offer the code as a pull request. It must contain no real person's name, phone number or address, no export file, no keys or passwords, and no screenshot of real data. Tests use invented people only.
3. Nothing is merged automatically. A person reads every line before it goes in, and may ask for changes or say no.

Before you open either, show them exactly what will be sent and read it yourself for anything real.

### 4. The real thing

1. A **second, separate** Vercel project and a second, separate database for the real app. Never turn the demo into the real one or share a database between them.
2. **Google sign-in**: in Google Cloud Console, create an OAuth web client; the redirect address is in `.env.example`. If they have Google Workspace, their Workspace administrator may need to do this.
3. Set the variables from `.env.example`: database, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (a new random value), the Google client, `OWNER_EMAILS`, and the member-data variables. Leave `NEXT_PUBLIC_CARE_DEMO` blank here.
4. Apply the migrations, deploy, and have an owner sign in and add the rest of the team.
5. Optional, each one only when they ask: their own web address; email (Resend); the daily job (`CRON_SECRET`); phone notifications; the AI reading of the Inbox (an Anthropic API key, which is paid by use); the Claude connector described in `README.md`, which lets a rabbi ask Claude "who needs me today?".

## Rules that are not optional

- Pastoral notes are the most private thing a congregation holds. They never go to logs, emails, analytics or to you in this chat. Do not ask them to paste real notes or real congregants' details here; work with invented examples.
- The membership system is read-only from this app. Do not add a way to write to it.
- No secrets in the repository. `.env*` files stay ignored.
- The demo and the real app are separate projects with separate databases, always.
- Before real people's data goes in, they should tell their board or senior rabbi where it will live (Vercel and Neon, both in the United States by default) and who can sign in.

## When you are stuck

Say plainly what is not working and what you tried. Do not guess at a fix that touches real data. The code is under the MIT licence (see `LICENSE`): they may change anything, and it comes with no warranty and no support.
