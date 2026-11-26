# CRC Care — product spec (v1)

<!-- impeccable:product-schema 1 -->

## Platform

web

A phone-first pastoral care app for the clergy of Central Reform Congregation (CRC), with a Claude connector. It replaces products like iRMS and the unused care pages of the MavenAI website. Decisions below were made by Daniel on 2026-11-23.

## Who it is for
- Launch: Daniel only.
- Next: the other CRC clergy.
- Later: Mitzvah Corps, the lay-led group whose members care for each other. Lay caregivers see far less than clergy. Roles exist in the data model from day one so this is a setting, not a rebuild.

Roles: `owner`, `clergy`, `caregiver`. Access is by email allowlist. Google sign-in, basic profile only.

## Operating Context
Confirmed by Daniel on 2026-11-23.
- A morning pass on the phone: see today’s dates, send texts, mark them done.
- Lookups on the move during the day, often one-handed and interrupted.
- Longer note-writing at a laptop. The desktop layout matters, not only the phone.

## Accessibility & Inclusion
Confirmed by Daniel on 2026-11-23.
- WCAG AA contrast, full keyboard use and screen-reader support.
- Layouts must hold up when the device text size is turned up: Mitzvah Corps volunteers may be older.

## The two jobs it must do well
1. **Lifecycle dates.** Today and this week: yahrzeits, shloshim, birthdays and anniversaries, so Daniel can text people on the day. Each row has the person, the occasion, and a button that opens the phone's Messages app with the number and a draft filled in (an `sms:` link; the app never sends anything itself). After texting, one tap marks it done for this year.
2. **Care list and follow-ups.** Who needs attention now (illness, bereavement, new baby, other), who on the team has them, and what is due. A follow-up has a due date and an owner; overdue ones surface at the top of Today.

Also in v1: a contact log (call, visit, text, other, with a short note) on each person, and a person page showing household, phone numbers, upcoming dates and history.

## Data
- **Salesforce is read-only.** People, households and dates come from Salesforce through a small client in this repo. Nothing is ever written to Salesforce. Reference for the queries and field names: `../MavenAI/src/lib/mcp/maven-lifecycle-types.ts` (a sibling checkout, where present), `maven-lifecycle-fields.ts`, `maven-lifecycle-bereaved.ts`, `maven-lifecycle-observers.ts`, `src/lib/hebcal/*`, and the JWT sign-in in `src/lib/sf-service-account.ts`. Lift the queries; do not import that code.
- A current member household is `Account.cs_Member__c = true`. Pin this with a test.
- No giving or financial data, ever. Those questions belong to the Maven connector.
- **Care records live in this app's own database**: care items, follow-ups, contact log, "texted this year" marks, users. A person is referenced by Salesforce Contact Id and household Account Id, with the name cached.
- Salesforce results are cached in the database for the day so screens are fast and the database is not woken by polling.

## Privacy
- A note is visible to all clergy by default. The author can mark it private; then only the author sees it, and others see only that a contact happened and when.
- Caregivers (later) see only care items assigned to them and their own notes. They never see clergy notes.
- Pastoral note text is never emailed, pushed or logged.

## Connector (MCP)
A small set of tools, each acting as the signed-in person with exactly their access:
- who needs me today (dates today, follow-ups due, open care items)
- upcoming dates for a window
- find a person; get a person's page
- log a contact
- add someone to the care list; set, move or close a follow-up; close a care item

## Not in v1
Reminders of any kind (no email, no push). Import from other systems. Writing to Salesforce. Sending texts from the app. Scheduled jobs that run more than once a day.

## Constraints learned from MavenAI
- The database bills by awake time. No polling crons. At most one daily job.
- Health and error alerts must not depend on the database they report on.
- Deploy only from git. The build must not run migrations against production implicitly; migrations are an explicit step.
- Tests must never be able to reach the production database.

## Address
`care.centralreform.org`. Until then, `crc-care.vercel.app`.

# v2 — a care system, not only a morning tool

Decided by Daniel on 2026-11-24. The full analysis is `docs/planning/2026-11-24-gap-analysis/GAP-ANALYSIS.md`. Where v2 and v1 disagree, v2 wins. Two v1 rules do not change: Salesforce is read-only, and pastoral note text is never emailed, pushed or logged.

## What changes
- **Intake.** Needs arrive by quick capture in the app, by telling Claude, by email to a `care@` address, by a phone dictation shortcut, by a staff quick-add and by a public form. There is no dedicated text number.
- **Inbox.** Every arrival is a proposal. Nothing from volunteers, congregants or email reaches the care list until clergy accept it. The one exception (Daniel, 2026-11-25): staff and Mitzvah Corps leads add directly, see the roles below. A rabbi's own capture is read straight back to that rabbi to confirm and never sits in the shared Inbox.
- **AI inside the app.** Approved. The app may call a Claude model on the server to sort arrivals. It is sent the message and a short list of candidate people, never a person's history. Retention terms are confirmed before any pastoral text is sent.
- **People outside Salesforce** can be cared for. They are stored only in this app and tagged as such.
- **Restricted items.** A care item can be restricted to named clergy. By default other clergy see only "In Rabbi X's care"; per item this can be set to nothing at all. No role, the owner included, overrides it.
- **Journeys.** Templates create follow-ups: bereavement year, illness and hospital, standing check-ins, new baby and simchas.
- **Volunteers** get a link that needs no account: claim a task, mark it done. A task never carries a diagnosis or a note.
- **Refer to Mitzvah Corps.** From a person's page (or by telling Claude) a rabbi sends the Mitzvah Corps lead what a volunteer needs: the kind of help, whether the person has said yes, how to reach them, whether the address may be shared, who is already involved, and whatever else the rabbi chooses to say. Nothing is copied from the care record: no category, no link into it.
  The lead sees it under "Referred by the rabbis" on their home, takes it, and closes it with one line the rabbis read on the person's page. While "a rabbi will ask first" the lead does not see it at all; it reaches her once a rabbi marks that the person agreed, or that she should ask. Other rabbis see that the person was referred, not by whom. What the rabbi tells the lead in a referral is the rabbi's to decide (Daniel, 2026-11-25: "Rabbi decides for sure. But broadly that's not the role of this app"): the app does not refuse or police the words. Volunteer tasks and public pages still never carry a reason. Nothing written is erased when a referral closes, and a closed referral is never deleted: the rabbis read all of it on the person's page. One nobody has taken after 60 days is withdrawn.
- **Mi Sheberach list**, with consent and expiry.
- **Outbound.** A contentless morning summary to the team, asks to volunteers, a thank-you to reporters. By email, push, or the sender's own phone.
- **No radar.** The app shows only what people put in.

## Roles
`owner`, `clergy`, `caregiver` as before, plus:
- `staff` (front office): report a need; see that it was picked up, nothing else. Staff and leads also **add directly**: a member straight onto a named rabbi's care list (optionally restricted to that rabbi) and a name straight onto the Mi Sheberach list, not yet confirmed. It is write-only: they see neither list, and the answer never says whether the person is already in care.
- `lead` (Mitzvah Corps lead): post and assign volunteer tasks; see logistics, never clergy notes.
- `senior_staff`: a coverage picture without names; report a need.
Congregants have no account; they use the public form.

## What is kept
Decided by Daniel on 2026-11-25. Asked whether a report's words should be refused or erased, he said: "When anyone writes, nothing should be refused. We want to maintain that information because that's useful for the rabbis to see." Asked about the timed deletions of what clergy write, he said: "I want it all kept." These replace the earlier rules (notes deleted three years after a care item closed unless marked "keep"; a report's words erased once it was accepted or dismissed; agenda entries deleted after 90 days; closed referrals deleted after 90 days).

- **Care notes** are not deleted on a timer: a care item's own text, its contact log notes and its follow-ups stay as written, however long ago it closed. The "Keep these notes" switch is gone, as there is nothing left for it to switch off.
- **A report's words** stay after a rabbi accepts or dismisses it. Only clergy read them back, as "Original report" on the care item it became, and only those who can see that item: a restricted item's original words are for its owner and the clergy named on it, the owner role included in "nobody else". When a sensitive report was added to an existing item as a note private to the rabbi who accepted it, the original words are that rabbi's alone too. A dismissed report's words are kept for the clergy who could have reviewed it, and shown to them under "Closed without action", a quiet link at the foot of the Inbox: newest closed first, with when it arrived, when and by whom it was closed, and where it came from. A rabbi's own capture there is theirs alone. Reopen puts a report back in the Inbox as pending, with its words only: the AI reading and a public sender's details, cleared at the dismissal, do not come back ("Read it again" can make a new reading). The reporter then sees it as pending again. Staff, leads, senior staff, caregivers and the person who sent the report never read them back: a reporter still sees only a date and a status. The AI's reading of a report is still cleared on the decision. The words are never in a log, an email, a push notice, an audit row or the connector.
- **Agenda entries** and their words are not deleted on a timer. A discussed entry still leaves the screen after two weeks.
- **Mitzvah Corps referrals** that have closed are kept, with the lead's one line.
- One exception, unchanged: when a rabbi leaves the clergy or is deactivated, their own unreviewed captures (which only they could ever have reviewed) are dismissed and their words erased.

The timers that remain concern other people's contact details and operational records, not what clergy wrote:
- A public sender's name and contact: cleared when their report is decided, except the name and email of a sender who agreed to be thanked, kept 30 days after the decision.
- Volunteers' and meal helpers' sign-up contact details, and people who left the volunteer roster: as before.
- A referral nobody took is withdrawn after 60 days; nothing written in it is erased.
- Capture keys unused for 180 days, set-aside suggestions, rate-limit counters, and the email and notification logs: as before.

## Still true
At most one daily scheduled job. Inbound email and form posts are single requests, not polling.
