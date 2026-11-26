---
name: CRC Care
description: A pastoral care app set like a page of the congregation's own prayer book, English on the left and Hebrew facing it.
colors:
  ground: "#f3f5f8"
  surface: "#ffffff"
  ink: "#16223b"
  rubric: "#4f6185"
  rule: "#d3dae8"
  rule-soft: "#e3e8f1"
  control: "#6c7ea3"
  tint: "#e9eef7"
  shell: "#1e2f55"
  shell-raised: "#2f4373"
  on-shell: "#ffffff"
  on-shell-muted: "#d5def2"
  action: "#1e2f55"
  action-strong: "#16223b"
  on-action: "#ffffff"
  selected: "#dde6f7"
  yahrzeit: "#1e2f55"
  yahrzeit-strong: "#16223b"
  yahrzeit-band: "#c9d9f8"
  shloshim: "#414852"
  shloshim-strong: "#2b3038"
  shloshim-band: "#c2c6cc"
  birthday: "#8a2846"
  birthday-strong: "#6e1d36"
  birthday-band: "#f9cfdb"
  anniversary: "#0b5563"
  anniversary-strong: "#083f4a"
  anniversary-band: "#bfe6e6"
  done: "#1c5a41"
  done-band: "#e1f0e8"
  alert: "#7a4300"
  alert-band: "#fdf1d8"
  focus: "#2456c9"
  focus-on-shell: "#ffffff"
typography:
  display:
    fontFamily: "Frank Ruhl Libre, Times New Roman, David, Arial Hebrew, Georgia, serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
  display-laptop:
    fontFamily: "Frank Ruhl Libre, Times New Roman, David, Arial Hebrew, Georgia, serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "Frank Ruhl Libre, Times New Roman, David, Arial Hebrew, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.375
  title:
    fontFamily: "Frank Ruhl Libre, Times New Roman, David, Arial Hebrew, Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.375
  name:
    fontFamily: "Frank Ruhl Libre, Times New Roman, David, Arial Hebrew, Georgia, serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.375
  hebrew:
    fontFamily: "Frank Ruhl Libre, Times New Roman, David, Arial Hebrew, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.375
  hebrew-title:
    fontFamily: "Frank Ruhl Libre, Times New Roman, David, Arial Hebrew, Georgia, serif"
    fontSize: "1.375rem"
    fontWeight: 500
    lineHeight: 1.375
  body:
    fontFamily: "Public Sans, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "Public Sans, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Public Sans, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
  rubric:
    fontFamily: "Public Sans, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: "0.09em"
rounded:
  sm: "0.25rem"
  md: "0.375rem"
spacing:
  control-gap: "0.5rem"
  card-gap: "0.75rem"
  card-pad: "1rem"
  gutter: "1rem"
  block: "1.25rem"
  section: "2rem"
  gutter-laptop: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.action-strong}"
    textColor: "{colors.on-action}"
  button-yahrzeit:
    backgroundColor: "{colors.yahrzeit}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-yahrzeit-hover:
    backgroundColor: "{colors.yahrzeit-strong}"
    textColor: "{colors.on-action}"
  button-shloshim:
    backgroundColor: "{colors.shloshim}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-shloshim-hover:
    backgroundColor: "{colors.shloshim-strong}"
    textColor: "{colors.on-action}"
  button-birthday:
    backgroundColor: "{colors.birthday}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-birthday-hover:
    backgroundColor: "{colors.birthday-strong}"
    textColor: "{colors.on-action}"
  button-anniversary:
    backgroundColor: "{colors.anniversary}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-anniversary-hover:
    backgroundColor: "{colors.anniversary-strong}"
    textColor: "{colors.on-action}"
  button-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-quiet-hover:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.ink}"
  button-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.action}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-on-shell:
    backgroundColor: "{colors.shell}"
    textColor: "{colors.on-shell}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-on-shell-hover:
    backgroundColor: "{colors.shell-raised}"
    textColor: "{colors.on-shell}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2.75rem"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "1rem"
  occasion-band-yahrzeit:
    backgroundColor: "{colors.yahrzeit-band}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    padding: "0.75rem 1rem"
  occasion-band-shloshim:
    backgroundColor: "{colors.shloshim-band}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    padding: "0.75rem 1rem"
  occasion-band-birthday:
    backgroundColor: "{colors.birthday-band}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    padding: "0.75rem 1rem"
  occasion-band-anniversary:
    backgroundColor: "{colors.anniversary-band}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    padding: "0.75rem 1rem"
  kind-tag-yahrzeit:
    backgroundColor: "{colors.yahrzeit}"
    textColor: "{colors.on-action}"
    typography: "{typography.rubric}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.375rem"
  kind-tag-shloshim:
    backgroundColor: "{colors.shloshim}"
    textColor: "{colors.on-action}"
    typography: "{typography.rubric}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.375rem"
  kind-tag-birthday:
    backgroundColor: "{colors.birthday}"
    textColor: "{colors.on-action}"
    typography: "{typography.rubric}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.375rem"
  kind-tag-anniversary:
    backgroundColor: "{colors.anniversary}"
    textColor: "{colors.on-action}"
    typography: "{typography.rubric}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.375rem"
  notice:
    backgroundColor: "{colors.alert-band}"
    textColor: "{colors.alert}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "0.75rem"
  nav-item:
    backgroundColor: "{colors.shell}"
    textColor: "{colors.on-shell-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
    height: "3rem"
  nav-item-current:
    backgroundColor: "{colors.shell-raised}"
    textColor: "{colors.on-shell}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
    height: "3rem"
---

# Design System: CRC Care

## Overview

**Creative North Star: "The Prayer-Book Page"**

Each person is set the way a siddur sets its two languages: English at the left, Hebrew facing it at the right of the same line. The screen reads as a page from the congregation's own book, on cool paper-white, in navy ink, under a deep navy shell. It is a working tool for a morning pass on a phone and for note-writing at a laptop, so the page is quiet, dense enough to scan, and every control is large enough for a thumb.

Colour does two jobs and no more: it says what is an action, and it says which of the four kinds an occasion is: a yahrzeit, a shloshim, a birthday or an anniversary. Both are always said in words as well, and a kind always carries its icon. Depth is carried by hairline rules and three flat tones of paper; nothing casts a shadow. The app is light mode only (`color-scheme: light`; there is no dark variant of anything).

This record describes the build at commit c4906d9. Where the build and the direction contract differ, the build is recorded: cards have gently eased corners (6px), not square ones, and today's civil date is itself the small group heading that carries the "n of m done" count.

**Key Characteristics:**
- Two languages on one line: English left, Hebrew right, the Hebrew dropping beneath when there is no room.
- Four occasion tones (yahrzeit navy-blue, shloshim graphite, birthday wine-rose, anniversary teal), each always with its word and its icon, and each day's cards gathered by kind.
- Navy shell: a top bar on a phone, a permanent side rail on a laptop.
- Two faces: Frank Ruhl Libre for names, titles and all Hebrew; Public Sans for everything else.
- Flat: hairline rules and paper tones, no shadows.
- Every target at least 44px; every text pairing at least 4.5:1; every control border at least 3:1.
- One authored motion: the done count closing.

## Colors

A cool paper-and-navy palette, with four tones kept for the four kinds of occasion: navy-blue, graphite, wine-rose and teal. Every colour is a token named for its job; Tailwind's own palette is switched off (`--color-*: initial`), so a class such as `bg-white` or `text-gray-500` does nothing.

### Primary
- **Shell Navy** (`shell`, `action`): the top bar, the side rail, the menu, primary buttons, links, and Hebrew set on the page. The two tokens hold one value and are kept apart by job.
- **Deep Ink Navy** (`action-strong`, `ink`): hover on a primary button; all body text.
- **Raised Navy** (`shell-raised`): the current page in the navigation, and hover on anything that sits on the shell.

### Secondary
The four kinds of occasion. Each kind has three tokens: a fill (its tag, the primary button of its rows, its Hebrew on the band, the heading over its group), a deeper fill for hover, and a band (the head of its card). A kind's tokens are used for that kind and nothing else.
- **Yahrzeit Navy** (`yahrzeit` #1e2f55, hover `yahrzeit-strong` #16223b) on the **Blue Band** (`yahrzeit-band` #c9d9f8). The fill is the same value as the action navy, kept apart by job.
- **Shloshim Graphite** (`shloshim` #414852, hover `shloshim-strong` #2b3038) on the **Grey Band** (`shloshim-band` #c2c6cc): greyer than a yahrzeit, and its band is the darkest of the four.
- **Birthday Wine** (`birthday` #8a2846, hover `birthday-strong` #6e1d36) on the **Rose Band** (`birthday-band` #f9cfdb).
- **Anniversary Teal** (`anniversary` #0b5563, hover `anniversary-strong` #083f4a) on the **Teal Band** (`anniversary-band` #bfe6e6).

Measured (WCAG contrast):

| Kind | White on fill | White on hover fill | Band against white | Band against ground | Ink on band | Fill on band (Hebrew) | Fill on ground (group heading) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Yahrzeit | 13.2 | 15.8 | 1.42 | 1.30 | 11.1 | 9.3 | 12.1 |
| Shloshim | 9.2 | 13.3 | 1.72 | 1.57 | 9.2 | 5.4 | 8.5 |
| Birthday | 8.5 | 11.1 | 1.40 | 1.28 | 11.3 | 6.1 | 7.8 |
| Anniversary | 8.4 | 11.5 | 1.34 | 1.23 | 11.8 | 6.3 | 7.7 |

Band against band, by lightness: shloshim is 1.21 against yahrzeit, 1.22 against birthday and 1.28 against anniversary. Yahrzeit, birthday and anniversary are close in lightness on purpose (1.01, 1.06 and 1.05 against one another) and are told apart by hue: blue, rose and teal. Against the state bands: the four are 1.14 to 1.46 against the done band and 1.20 to 1.53 against the alert band, and neither green nor amber is the hue of any kind. Rubric is below 4.5:1 on these bands (3.6 to 4.6), so text on a band is ink or the kind's own fill, never rubric.

### Tertiary
- **Done Green** (`done` on `done-band`): "Texted", "Done", "Copied", a saved form, and the line that says all of today's dates are done.
- **Alert Amber** (`alert` on `alert-band`): an overdue follow-up, a form error, and the notice that something could not be loaded.
- **Focus Blue** (`focus`): the focus ring on the page. On the shell the ring is white (`focus-on-shell`).

### Neutral
- **Cool Paper** (`ground`): the page, the bottom bar and the inside of a sheet.
- **White** (`surface`): cards, inputs and quiet buttons.
- **Blue-Grey Rubric** (`rubric`): group headings, secondary lines, drafts, placeholders and empty states.
- **Hairline** (`rule`) and **Soft Hairline** (`rule-soft`): the edge of a card and the line under a band; the lines between rows inside a card. Dividers only.
- **Control Blue-Grey** (`control`): the border of an input, a quiet button, a search result and a sheet; the underline of a name that is a link.
- **Tint** (`tint`): hover on a quiet control or a list row, and the ground behind inline code.
- **Selected** (`selected`): the fill of a chosen filter.
- **On-Shell Muted** (`on-shell-muted`): the Hebrew date on the navy bar, links in the navigation that are not the current page, the signed-in line.

`shell` and `ground` are repeated in `src/lib/brand.ts` for the app icon, the manifest and the browser theme colour, which CSS cannot reach. Change them together.

### Named Rules
**The Four Kinds Rule.** A kind is told three ways at once, and never by colour alone: its word, its icon and its tone. Wherever a kind appears it is a kind tag: the icon and the word in capitals, white on the kind's fill. The tag opens every card's title, counts each kind on a day ("2 yahrzeits") on Today's week lines and Upcoming's day headings, and labels each date on a person's page. On a card the same tone is also the band behind the title and the one solid button of each row. The icons are drawn in one line weight: a candle with its flame (yahrzeit), a memorial lamp (shloshim), a balloon (birthday), two linked rings (anniversary). Three of the bands are alike in lightness and differ by hue, which is why the word and the icon are never left out.

**The Gathered By Kind Rule.** Within a day (today, tomorrow, each day on Upcoming) the cards are gathered by kind in one fixed order: yahrzeit, shloshim, birthday, anniversary. Each kind present has its own heading with its count ("Yahrzeits · 3"), in the rubric style, in the kind's fill, with its icon; a kind with no cards has no heading. The count is the number of cards beneath it; a yahrzeit or a shloshim counts once for each mourner. Counts and tags follow the same order. The "In shloshim" group on Today is one kind already and has no kind headings. Done rows keep the same order inside their closed group. The same holds for state: "Texted" and a chosen filter carry a check mark, overdue is worded and set heavier, done is the word "Done".

**The Contrast Floor Rule.** Text is at least 4.5:1 against whatever it sits on; a control's border is at least 3:1. Measured in the build: the lowest text pairing is the shloshim fill on its own band at 5.4:1 (its Hebrew); rubric is 5.7:1 on ground and 6.2:1 on white and is not used on an occasion band; ink is 9.2:1 or better everywhere, the lowest being on the shloshim band; white on a kind's fill is 8.4:1 or better; `control` is 3.7:1 on ground, 4.1:1 on white and 3.5:1 on tint. A new pairing is measured before it ships.

**The Rule-Or-Border Rule.** `rule` and `rule-soft` are about 1.3:1 and are for dividers and card edges only. Anything a person can type into or press that is defined by its outline takes `control`.

**The One Solid Button Rule.** A row has one solid button. On an occasion it is "Text <first name>", in the fill of the occasion's kind; once the text has been opened, Text turns quiet and Done takes the solid fill. A chosen filter is never solid: solid means "primary action".

## Typography

**Display Font:** Frank Ruhl Libre (with Times New Roman, David, Arial Hebrew, Georgia, serif), Latin and Hebrew subsets
**Body Font:** Public Sans (with system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif)

**Character:** A bookish serif that has a true Hebrew, so a name and its Hebrew are one face, against a plain, sturdy sans for everything the hand has to operate. Both are served from the app's own origin (`next/font`, `font-src 'self'`); no page asks another host for a font.

### Hierarchy
- **Display** (serif 700, 1.375rem on a phone, 1.875rem on a laptop, line-height 1.25): the page's one h1. On a phone it sits on the navy bar; on a laptop it sits on the page over a hairline.
- **Headline** (serif 700, 1.25rem, 1.375): the title of a sheet, and "CRC Care" in the rail and the menu.
- **Title** (serif 700, 1.125rem, 1.375): the title of a card, a day in Upcoming, a search result.
- **Name** (serif 600, 1.0625rem, 1.375): a person inside a card or a list.
- **Hebrew** (serif 500, right-to-left; 1.25rem beside a name, 1.375rem beside a title or on the bar, 2rem facing a laptop h1, 1.125rem in a day line): always one step larger than the English it faces, so the two look the same size.
- **Body** (sans 400, 1rem, 1.5): notes, inputs, follow-up titles, navigation links. Inputs are never smaller than 1rem.
- **Small** (sans 400, 0.875rem): secondary lines, drafts, notices, empty states. Counts and dates in columns use tabular figures.
- **Label** (sans 600, 0.875rem): buttons and field labels.
- **Rubric** (sans 700, 0.75rem, 0.09em, uppercase, in `rubric`): the heading of a group of cards, and the label over a group of filters.

### Named Rules
**The Facing Line Rule.** English at the left and Hebrew at the right of the same baseline, with the Hebrew dropping beneath, still at the right, when the line is too narrow. It is used on the page header (the Hebrew date on Today and on sign-in; a person's Hebrew name on their page), on every occasion card title, on the line of a memorial card that names the deceased, on each person to reach, on search results, on household members and on each day's heading.

**The Nothing-Rather-Than-Invented Rule.** The Hebrew side holds only what the record holds. Beside the deceased on a memorial card it is the Hebrew date of death, written as on a memorial stone ("י׳ בטבת תשפ״ג": day in letters, ב and the month, the year without its thousands), under the deceased's Hebrew name when Salesforce has one. On a person (the mourner in a memorial card's title among them) it is their Hebrew name where Salesforce has one. Where there is none, the right side is empty and the line is simply English. A household's name has no Hebrew of its own. Nothing is transliterated, translated or guessed.

**The Latin-Letter Rule.** A Hebrew name that Salesforce holds in Latin letters is set in the serif italic at 1rem, left to right, marked `he-Latn`, and is not enlarged or announced as Hebrew. Real Hebrew is marked `he` and `rtl`.

**The Two Faces Rule.** Serif for names, titles and Hebrew; sans for everything else. A button, a label or a notice is never serif; a person's name is never sans where it is the subject of a row.

**The Rubric Is A Heading Rule.** The small uppercase rubric is the real heading of its group (an h2) or the visible label of a filter group. It is never set as a line above another heading. The outline has no skips: the page title is the h1, a day or a group is an h2, a kind within a day is an h3 (as is the heading of a closed done group), and a card's title is an h4. In a group with no kind headings ("In shloshim") the card's title is an h3. A card's heading reads in full to a screen reader ("Birthday: Ruth Cohen", "Anniversary: …"). A memorial card is its mourner's, and its heading says so before it says whose it is ("Dana Levy, Yahrzeit of Sarah Levy", "…, Shloshim for …"); with no one to contact it is the deceased's ("Yahrzeit of Sarah Levy"). On screen it is the tag and then the name.

## Layout

One column, centred, on the cool paper ground.

- **Phone (default):** a sticky navy top bar (at least 3.5rem tall) holding the menu button and the h1 with its facing Hebrew; a column of at most 36rem with 1rem gutters; a fixed bottom bar with one large link ("Find a person", or the care list for a caregiver), hidden on the page it leads to. The column ends with 8rem of space so the bar never covers the last row. The menu is a left drawer (the lesser of 20rem and 85% of the width).
- **Laptop (64rem and wider):** a permanent navy side rail, 16rem wide and the full height of the window, replaces the top bar, the drawer and the bottom bar. The h1 moves onto the page, in ink at 1.875rem, with its Hebrew in navy at 2rem, over a hairline. The column is at most 48rem with 2rem gutters.
- **A person's page on a laptop** is set in two: the record at the left, and the log-a-contact form on the page at the right (at most 22rem), sticky beside the history, inside a 64rem column. The "Log a contact" button and its sheet are for phones; on a laptop the button is hidden and an arrival that would open the sheet puts focus in the form instead.
- **Pages outside the shell** (sign-in, not authorised, consent, errors): the same navy bar and a 24rem column with 1.5rem gutters.

Rhythm: 2rem between groups, 0.5rem from a group heading to its first card, 0.75rem between cards, 1rem inside a card, 0.5rem between buttons, 1.25rem between unrelated blocks at the top of a page. Rows wrap; nothing scrolls sideways at 320px, and long names and addresses break anywhere.

Order on Today follows the morning: follow-ups that are due, today's dates with their count, households in shloshim, tomorrow in full, then the rest of the week as one line per day. Rows still to do come first; done rows move into a closed "Done (n)" group beneath, at full contrast, where they can be undone.

### Named Rules
**The Forty-Four Rule.** Every target is at least 2.75rem (44px) tall: buttons, inputs, text links, name links, list rows, the menu button, disclosure summaries. Navigation links and the bottom bar's link are 3rem.

**The Short Screen Rule.** When the viewport is 36rem tall or less (a landscape phone, or text enlarged until the screen holds a few lines), the top bar, the bottom bar and the laptop's sticky form stop sticking and scroll with the page. Scroll padding (4.5rem top, 7rem bottom on a phone; 1rem on a short screen or a laptop) keeps a focused control out from under the bars.

**The Laptop Is Not A Wide Phone Rule.** On a laptop a button that spans the column on a phone takes the width of its words with a floor of 11rem and sits at the start of its row; drafts are shown whole and no longer clamped to two lines; the note is written on the page, not in a sheet.

## Elevation & Depth

Flat. No element has a shadow. Depth is three paper tones (ground, white surface, tinted band) and two weights of hairline. A sheet and the menu are native modal dialogs: they are lifted by a backdrop of ink at 45%, a `control` border and, on a phone, by rising from the bottom edge. The page behind an open dialog does not scroll.

### Named Rules
**The Flat Page Rule.** A surface is told from the ground by its tone and its hairline, never by a shadow. Hover changes tone (`tint`, `shell-raised`, `action-strong`); it does not lift.

## Shapes

Gently eased rectangles. Cards, buttons, inputs, notices, navigation items and sheets share one radius (0.375rem); the kind tags and inline code take 0.25rem. There are no pills and no circles. A card is a white surface with a 1px hairline and, on an occasion, a tinted band across its top that the card's corners clip. A sheet on a phone is eased at the top only and square where it meets the bottom edge. Borders are 1px; the one exception is the chosen filter at 2px. The focus ring is a 3px outline, 2px off the control (drawn inside the row on a full-width list row), blue on the page and white on the shell.

Icons are five small stroked line drawings (menu, search, check, chevron, back), inline, in the current text colour, and always beside words or under an accessible name.

## Components

Plain and steady: a control looks the same wherever it appears, and says in words what it will do.

### Buttons
- **Shape:** eased rectangle (0.375rem), at least 2.75rem tall, 0.5rem by 1rem padding, Public Sans 600 at 0.875rem, centred. Disabled is 60% opacity; a saving button says "Saving…".
- **Primary:** navy fill, white text; hover deepens to ink navy.
- **Of a kind:** the fill of the occasion's kind (navy, graphite, wine or teal), white text; hover deepens to the kind's strong fill. Only the primary of an occasion row.
- **Quiet:** white fill, ink text, 1px `control` border; hover is tint. Call, Done before texting, Close, Cancel, Reset.
- **On the shell:** transparent on navy, white text, 1px muted border; hover is raised navy.
- **Text link:** navy, medium weight, underlined 4px below the text, still 2.75rem tall. Names that are links are underlined in `control`, turning navy on hover.
- **Width:** as wide as its words. "Text <first name>" grows to fill its row beside Call on a phone; a form's submit spans its sheet on a phone. On a laptop both take the 11rem floor instead.
- **Transitions:** colour only.

### Chips
- **Style:** a filter is a quiet button.
- **State:** the chosen one has a 2px navy border, the selected tint, navy text and a check mark before its label, and is marked as current. Never the solid fill.

### Cards / Containers
- **Corner Style:** 0.375rem.
- **Background:** white on the cool paper ground.
- **Shadow Strategy:** none; see Elevation & Depth.
- **Border:** 1px hairline. A card that is itself one link (a search result) takes the `control` border.
- **Internal Padding:** 1rem. An occasion card has no padding of its own: its band and each row are 0.75rem by 1rem, with soft hairlines between rows.
- **List card:** rows of at least 2.75rem divided by soft hairlines inside one hairline border (the week's days, household members, a person's dates); a row that is a link tints on hover.

### Occasion card (signature)
A tinted title band over the person to reach. A yahrzeit or a shloshim is one card for each mourner, so the person to contact leads; the mourners of one death are separate cards, kept next to one another.
- **Memorial band:** the band of the card's kind, hairline beneath, holding two facing lines and Done. The title is the kind tag, then the mourner's name in serif, a link to their page (the name drops beneath the tag when there is no room), faced by the mourner's Hebrew name at 1.375rem in the kind's fill. The second line, in ink at 0.875rem, says whose it is: the relationship and the deceased, then the years or the dates of the shloshim ("Parent: Sarah Levy · 33 years", "Spouse: … · died Sat, Oct 31 · shloshim ends Mon, Nov 30"; with no relationship on file, the name alone). The Hebrew date of death faces that line at 1.25rem in the kind's fill, under the deceased's Hebrew name when there is one. Done is at the top right of the band, beside the title. Everything on a band is ink or the kind's fill, never rubric.
- **Beneath a memorial band:** the mourner's household in rubric, when it is not already their name. Then the draft ("Draft:" and the words to be sent; two lines on a phone, all of it on a laptop). Then "Text <first name>" and Call.
- **No one to contact:** a yahrzeit or a shloshim with nobody on file stays one card titled with the deceased: the tag and their name, the years or dates beneath, the Hebrew date of death facing, and "No one to contact on file." with Done.
- **Celebration band:** the kind tag, then the name in serif, with a small line in ink under it that says only what the tag does not ("Turns 40", "25 years married"). Right: the Hebrew name, right-aligned at 1.375rem, in the kind's fill.
- **Celebration row:** when the title already names the person, the draft, then "Text <first name>", Call and Done at the end of the button row. When someone else is to be reached, their name (a link) with their Hebrew name facing, the household beneath in rubric and Done at the top right, then the draft, Text and Call.
- **States:** texted shows a green check and "Texted", Text turns quiet and Done turns solid. Done moves the card into the closed group and offers Undo; each mourner's card is marked and undone on its own. No number shows "No number on file." and a link to the person.

### Inputs / Fields
- **Style:** white, 1px `control` border, 0.375rem, at least 2.75rem tall, 1rem text; placeholder in rubric. The label sits above in sans 600. A note box is at least 12rem tall and resizes vertically.
- **Focus:** the 3px blue ring, 2px off. Checkboxes are 1.25rem inside a 2.75rem label and take the navy accent.
- **Error / Saved:** a line beneath the form, amber and medium weight for an error, green for saved. A failed save keeps what was typed.

### Navigation
- **Shell:** navy. Links are 3rem rows in muted white at 1rem; hover raises the row and whitens the text; the current page is raised, bold and white, and marked as current. "CRC Care" in serif heads the rail and the menu, with the signed-in name and role beneath, and Sign out under a raised-navy line.
- **Phone:** a 2.75rem menu button on the bar opens the drawer; the bottom bar holds one 3rem link styled as a search field with a magnifier.
- **Laptop:** the rail is always there; there is no menu button and no bottom bar.

### Sheets
A native modal dialog on the cool paper ground: on a phone it rises from the bottom edge, full width up to 36rem and at most 90% of the height; from 40rem wide it is a bordered panel near the top; on a laptop up to 42rem. A serif title and a quiet Close over a hairline. Focus starts in the first field, or on Cancel in a confirmation. A tap on the backdrop closes it unless a note has been typed.

### Notices and marks
- **Notice:** amber text on the amber band, 0.375rem, 0.75rem padding, no border and no icon. Used when part of a page could not be loaded; the rest of the page stays.
- **All done:** the same shape in green, when every one of today's dates is done.
- **Kind tag:** a 1rem icon and the kind's word (or its count, "2 yahrzeits") in sans 700 at 0.75rem, 0.06em, capitals, white on the kind's fill, 0.25rem corners, 0.125rem by 0.375rem padding. Its words wrap inside it when text is enlarged. It is a label, not a control.
- **Kind heading:** the kind's icon, its plural and its count ("Yahrzeits · 3") in the rubric style, in the kind's fill; 1rem above it, 0.5rem to its first card.
- **Loading:** blocks in the hairline tones where the content will be, pulsing slowly (1.6s) unless reduced motion is asked for.

### Done count (the one authored motion)
"n of m done" sits at the right of today's heading in rubric with tabular figures. When a row is marked done, the count settles once: from 0.2em low, 112% and 40% opacity to rest in 280ms on `cubic-bezier(0.16, 1, 0.3, 1)`, anchored at its right edge. It does not play on arrival or on an undo, nor for anyone who asks for reduced motion. Everything else that moves is state feedback: colour on hover, and a day's chevron turning when it opens. Reduced motion stops all of it.

## Do's and Don'ts

### Do:
- **Do** set a person's English and Hebrew on one facing line, English left, Hebrew right, the Hebrew one step larger and in the same serif.
- **Do** leave the Hebrew side empty when Salesforce has no Hebrew for it.
- **Do** show the kind of an occasion as its tag (icon, word and fill together) wherever the kind appears, and pair every state colour with a word or a check mark.
- **Do** gather a day's cards by kind in the fixed order yahrzeit, shloshim, birthday, anniversary, each kind under its own counted heading.
- **Do** take every colour from the named tokens, and measure a new pairing: text at least 4.5:1, a control's border at least 3:1.
- **Do** keep every target at least 2.75rem tall and every input's text at least 1rem.
- **Do** let sticky and fixed bars scroll with the page when the viewport is 36rem tall or less.
- **Do** give a laptop its own arrangement: the side rail, buttons the width of their words with an 11rem floor, the whole draft, and forms for long writing set on the page.
- **Do** keep one solid button in a row: on an occasion in the fill of its kind, everywhere else the action navy.
- **Do** show done rows at full contrast in their closed group.

### Don't:
- **Don't** tell one kind of occasion from another, chosen from unchosen, or done from not done by colour alone.
- **Don't** set rubric-coloured text on an occasion band; use ink or the kind's fill.
- **Don't** write, transliterate or guess a Hebrew name or date that the record does not hold, and don't enlarge or right-align a Hebrew name held in Latin letters.
- **Don't** add a dark theme or any dark variant; the app is light mode only.
- **Don't** use the hairline colours on the border of an input or a button.
- **Don't** use the solid fill for a chosen filter.
- **Don't** add shadows, pills or a second radius scale.
- **Don't** set buttons, labels or notices in the serif, or load a font from another origin.
- **Don't** use a kind's fill or band for anything but that kind, or interleave kinds within a day.
- **Don't** add a second authored animation, or any motion that plays on arrival.
- **Don't** set the rubric as a line above another heading.
