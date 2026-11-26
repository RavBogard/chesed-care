# The demo

A copy of the app that other congregations can open and play with. It is the same code, built with one switch on.

## What a visitor gets
- A front page at `/demo` that says what the app is and lets them choose who to be: the senior rabbi, a second rabbi, the Mitzvah Corps lead, the front office or the executive director. There is no sign-in.
- Congregation Beit Dugma ("house of example"): 14 invented households with birthdays, yahrzeits, two recent deaths and a new baby. Every date is counted from today, so there is always something on Today.
- A starting story written through the app's own functions: a care list (one item restricted), follow-ups due and overdue, an Inbox with five arrivals, the Mi Sheberach list, volunteer tasks, a shiva sheet, a roster, a referral, the visiting list and a live meal page.
- One shared sandbox. It goes back to the starting story on the first visit of each day, and when anyone presses "Start over now" on the front page.

## What is switched off
Google sign-in, the Claude connector, the dictation shortcut, Salesforce (an invented congregation answers instead), email and the AI reading of the Inbox are off in a demo build whatever else is configured. Phone notifications and the Mi Sheberach packet stay off as long as their variables are not set: do not set them.

## Setting it up (once)
1. Make a **new, empty Postgres database** (a new Neon project). Never point the demo at the real one.
2. Apply the migrations to it: `DATABASE_MIGRATION_URL=<the demo database> npm run db:migrate`.
3. Make a **second Vercel project** from this repository, with these variables and no others:
   - `NEXT_PUBLIC_CARE_DEMO=on`
   - `DATABASE_URL` = the demo database (pooled)
   - `BETTER_AUTH_SECRET` = a new random value (`openssl rand -base64 48`); it signs the volunteers' links
   - `BETTER_AUTH_URL` = the demo's own address, e.g. `https://beit-dugma-care.vercel.app`
   - optional: `DEMO_ACCESS_CODE` = a short code visitors type once (capitals and spaces around it do not matter). Use one when the link goes to a list or a group, so strangers and bots cannot write in the shared sandbox. Send it with the link. The public pages (`/tell`, `/join`, volunteers' and meal links) stay open, as in the real app.
4. Deploy, open `/demo`, choose a role. The first visit writes the story (a few seconds).

After a release with a new migration, apply it to the demo database too before the demo redeploys.

## The fences
- The switch is fixed into the build (`NEXT_PUBLIC_…`), so a deployment is a demo or it is not.
- A demo build lets a visitor in only as one of five accounts ending `@beitdugma.invalid`, and never creates them on request: they exist only in a database the reset has prepared.
- The reset empties every table, so it refuses any database holding an account that is not a demo account. Pointed at the real database by mistake, a demo build would let nobody in, read no real Salesforce data and change nothing.
- `tests/demo.test.ts` runs every Salesforce query the app builds through the invented congregation, writes the whole story, and checks the fences.

## Changing the story
The people are in `src/server/demo/congregation.ts`; what has happened to them is in `src/server/demo/seed.ts`. The names on the screen are in `src/lib/brand.ts`, the five roles in `src/lib/demo.ts`.
