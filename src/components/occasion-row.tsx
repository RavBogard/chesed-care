import Link from "next/link";
import { shortDate } from "@/lib/format";
import { cleanLabel, isMemorial, type OccasionCard } from "@/server/lifecycle/cards";
import { draftFor, smsHref, telHref, textableNumber } from "@/server/lifecycle/sms";
import type { Occasion } from "@/server/lifecycle/types";
import { Hebrew } from "./hebrew";
import { KindTag } from "./kind-tag";
import { OccasionMark, OccasionPerson, type PersonRow } from "./occasion-person";
import { facingLine, kindBand, kindText, nameLink, titleClass } from "./ui";

type Own = Partial<Record<Occasion["type"], string>>;

export function markFields(o: Occasion) {
  return { occasionType: o.type, subjectId: o.subjectId, sfAccountId: o.accountId ?? "", sfContactId: o.contactId ?? "", year: String(Number(o.date.slice(0, 4))) };
}

function isSelf(o: Occasion): boolean {
  return o.type === "birthday" && o.contactId !== null && o.contactId === o.subjectId;
}

/**
 * What Done refers to, for its accessible name and the announcement. A memorial is named for
 * its mourner first, as its card is: "Dana Levy's yahrzeit for Sarah Levy"; with nobody to
 * contact it is the deceased's own, "Sarah Levy's yahrzeit".
 */
function subjectOf(o: Occasion, mourner: string | null): string {
  const about = cleanLabel(o.personName);
  if (isMemorial(o.type)) {
    if (mourner) return `${mourner}'s ${o.type}${about ? ` for ${about}` : ""}`;
    return about ? `${about}'s ${o.type}` : `This ${o.type}`;
  }
  switch (o.type) {
    case "birthday":
      return `${cleanLabel(o.personFirstName) ?? about ?? "This"}'s birthday`;
    case "anniversary":
      return `${cleanLabel(o.informalGreeting) ?? about ?? "This"}'s anniversary`;
  }
  return "This";
}

/** Everything one person's row needs, worked out on the server so the row itself stays small. */
export function personRow(o: Occasion, today: string, done: boolean, drafts: Own): PersonRow {
  const contact = cleanLabel(o.contactName);
  const household = cleanLabel(o.household);
  const about = cleanLabel(o.personName);
  const self = isSelf(o);
  // An observer row that is the deceased (same name) is not someone to contact.
  const named = contact ?? household;
  const isDeceased = isMemorial(o.type) && named !== null && about !== null && named.toLowerCase() === about.toLowerCase();
  const name = self || isDeceased ? null : named;
  const firstName = cleanLabel(o.contactFirstName) ?? contact?.split(" ")[0] ?? null;
  const number = isDeceased ? null : textableNumber(o);
  const draft = number ? draftFor(o, today, drafts) : null;
  const relation = name && household && household !== name && household !== about ? household : null;
  return {
    textedKey: `crc-care:texted:${o.type}|${o.subjectId}|${o.accountId ?? ""}|${o.date.slice(0, 4)}`,
    done,
    name,
    missing: !self && !name,
    personHref: o.contactId && !isDeceased ? `/people/${o.contactId}` : null,
    relation,
    relationship: name && isMemorial(o.type) ? cleanLabel(o.relationship) : null,
    firstName,
    subject: subjectOf(o, name),
    sms: number && draft !== null ? smsHref(number, draft) : null,
    call: isDeceased ? null : (telHref(o.mobile) ?? telHref(o.phone)),
    draft,
    // Only when the row names that very person: a household's name has no Hebrew name of its own.
    hebrewName: name !== null && name === contact ? o.contactHebrewName : null,
    fields: markFields(o),
  };
}

/**
 * What joins the kind to the name in a card's heading. On screen the tag and the name stand
 * side by side; read aloud, or listed among the headings, it is "Birthday: Ruth Cohen", and
 * on a memorial "Dana Levy, Yahrzeit of Sarah Levy" (the mourner, then whose it is).
 */
const JOIN: Record<Occasion["type"], string> = { yahrzeit: " of ", shloshim: " for ", birthday: ": ", anniversary: ": " };

/** The line under the title. The tag already says the kind, so this says only what the kind does not. */
function detail(card: OccasionCard): string {
  switch (card.type) {
    case "birthday":
      return card.years ? `Turns ${card.years}` : "";
    case "anniversary":
      return card.years ? `${card.years} ${card.years === 1 ? "year" : "years"} married` : "";
    case "yahrzeit":
      // The first is its own occasion: the year of mourning has just ended.
      return card.years === 1 ? "First yahrzeit" : card.years ? `${card.years} years` : "";
    case "shloshim":
      return [card.deathDate ? `died ${shortDate(card.deathDate)}` : null, `shloshim ends ${shortDate(card.date)}`].filter(Boolean).join(" · ");
  }
}

const cardClass = "overflow-hidden rounded-md border border-rule bg-surface";
const bandClass = "border-rule px-4 py-3 not-last:border-b";

/**
 * A yahrzeit or a shloshim with someone to contact: the card is the mourner's. The band holds
 * two facing lines and Done. First the title: the kind's tag and the mourner's name (a link to
 * their page), faced by the mourner's own Hebrew name. Then whose it is: the relationship and
 * the deceased, then the years or the dates of the shloshim, faced by the Hebrew date of death
 * (under the deceased's Hebrew name, in the rare case there is one). Everything on the band is
 * ink or the kind's fill. Beneath the band: the household, the draft, Text and Call.
 * In the heading the name comes first, so it reads "Dana Levy, Yahrzeit of Sarah Levy"; the
 * tag is only drawn ahead of the name.
 */
function MournerCard({ card, row, level }: { card: OccasionCard; row: PersonRow; level: 3 | 4 }) {
  const Title = level === 3 ? "h3" : "h4";
  const whose = [[row.relationship, card.name].filter(Boolean).join(": "), detail(card)].filter(Boolean).join(" · ");
  const facing = [card.hebrewName, card.hebrewDeathDate].flatMap((t) => (t && t.trim() ? [t.trim()] : []));
  // Done, with nothing left to say or do beneath: the band is the whole card.
  const bare = row.done && !row.relation;
  return (
    <li className={cardClass} data-testid="occasion-card" data-occasion-type={card.type}>
      <div className={`${bandClass} ${kindBand[card.type]}`}>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1 basis-40">
            <div className={facingLine}>
              <Title className={`${titleClass} flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1`}>
                {row.personHref ? (
                  // A long name wraps to several lines: the margin is small enough that it never runs into the line beneath.
                  <Link href={row.personHref} className={`${nameLink} -my-1 min-w-0`}>
                    {row.name}
                  </Link>
                ) : (
                  <span className="min-w-0 break-words text-pretty">{row.name}</span>
                )}
                <span className="sr-only">, </span>
                <span className="order-first inline-flex max-w-full min-w-0">
                  <KindTag type={card.type} />
                </span>
                {card.name ? (
                  <span className="sr-only">
                    {JOIN[card.type]}
                    {card.name}
                  </span>
                ) : null}
              </Title>
              {row.hebrewName ? (
                <Hebrew size="text-[1.375rem]" className={kindText[card.type]}>
                  {row.hebrewName}
                </Hebrew>
              ) : null}
            </div>
            {whose || facing.length ? (
              <div className={`${facingLine} mt-1`}>
                {whose ? (
                  <p className="min-w-0 text-sm break-words text-ink" data-testid="occasion-whose">
                    {whose}
                  </p>
                ) : null}
                {facing.length ? (
                  <p className="ml-auto flex max-w-full flex-col items-end" data-testid="occasion-facing">
                    {facing.map((text) => (
                      <Hebrew key={text} className={kindText[card.type]}>
                        {text}
                      </Hebrew>
                    ))}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <OccasionMark row={row} kind={card.type} />
        </div>
      </div>
      {bare ? null : (
        <ul>
          <OccasionPerson row={row} kind={card.type} headed />
        </ul>
      )}
    </li>
  );
}

/**
 * One occasion, titled on the band of its kind in two facing columns, English at the left and
 * Hebrew at the right (beneath, when there is no room). The title opens with the kind's tag
 * (icon and word on the kind's fill), then the name; each person to reach is a row beneath.
 * The kind is told by the word and the icon, and the tone goes with them: never the tone alone.
 * A memorial with someone to contact is that mourner's card instead (see MournerCard); with
 * nobody to contact it is titled here, with the deceased.
 * `level` is the heading level of the title: one below whatever heads the group it sits in.
 */
export function OccasionCardView({ card, today, isDone, drafts = {}, level = 4 }: { card: OccasionCard; today: string; isDone: (o: Occasion) => boolean; drafts?: Own; level?: 3 | 4 }) {
  const memorial = isMemorial(card.type);
  const first = card.people[0];
  if (memorial) {
    const row = personRow(first, today, isDone(first), drafts);
    if (row.name) return <MournerCard card={card} row={row} level={level} />;
  }
  const selfHref = !memorial && isSelf(first) && first.contactId ? `/people/${first.contactId}` : null;
  const line = detail(card);
  // The Hebrew column: the name (rare on a memorial) over the Hebrew date of death; on a celebration, the name alone.
  const facing = [card.hebrewName, memorial ? card.hebrewDeathDate : null].flatMap((t) => (t && t.trim() ? [t.trim()] : []));
  const Title = level === 3 ? "h3" : "h4";
  return (
    <li className={cardClass} data-testid="occasion-card" data-occasion-type={card.type}>
      <div className={`${bandClass} ${kindBand[card.type]}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="min-w-0 flex-1 basis-40">
            <Title className={`${titleClass} flex flex-wrap items-center gap-x-2.5 gap-y-1`}>
              <KindTag type={card.type} />
              {card.name ? (
                <>
                  <span className="sr-only">{JOIN[card.type]}</span>
                  {selfHref ? (
                    <Link href={selfHref} className={`${nameLink} -my-2 min-w-0`}>
                      {card.name}
                    </Link>
                  ) : (
                    <span className="min-w-0 break-words text-pretty">{card.name}</span>
                  )}
                </>
              ) : null}
            </Title>
            {line ? <p className="mt-0.5 text-sm text-ink">{line}</p> : null}
          </div>
          {facing.length ? (
            <p className="ml-auto flex max-w-full flex-col items-end" data-testid="occasion-facing">
              {facing.map((text) => (
                <Hebrew key={text} size="text-[1.375rem]" className={kindText[card.type]}>
                  {text}
                </Hebrew>
              ))}
            </p>
          ) : null}
        </div>
      </div>
      <ul className="divide-y divide-rule-soft">
        {card.people.map((o) => (
          <OccasionPerson key={`${o.accountId ?? ""}|${o.contactId ?? ""}`} row={personRow(o, today, isDone(o), drafts)} kind={card.type} />
        ))}
      </ul>
    </li>
  );
}
