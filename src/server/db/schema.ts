// CRC Care's own records. People are referenced by Salesforce Contact Id and
// household Account Id (or an outside_people row) with the name cached; nothing here is written back to
// Salesforce. Who may see what is decided in src/server/access/policy.ts.
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["owner", "clergy", "caregiver", "staff", "lead", "senior_staff"]);
export const careCategory = pgEnum("care_category", ["illness", "bereavement", "birth", "other", "ongoing", "caregiver", "life_change", "mental_health", "simcha"]);
// new: nothing has happened yet. paused: hidden until paused_until (compared at read time; no job).
export const careStatus = pgEnum("care_status", ["open", "closed", "new", "paused"]);
/** How a care item or a proposal arrived. */
export const careSource = pgEnum("care_source", ["clergy", "capture", "connector", "email", "form", "staff", "voice", "salesforce", "shortcut"]);
export const contactOutcome = pgEnum("contact_outcome", ["spoke", "no_answer", "left_message", "visited", "texted"]);
export const reviewScope = pgEnum("review_scope", ["submitter", "clergy"]);
export const proposalStatus = pgEnum("proposal_status", ["pending", "accepted", "dismissed"]);
export const careVisibility = pgEnum("care_visibility", ["clergy", "caregivers"]);
export const contactKind = pgEnum("contact_kind", ["call", "visit", "text", "other"]);
export const occasionType = pgEnum("occasion_type", ["yahrzeit", "shloshim", "birthday", "anniversary"]);
/** How a person gets the morning summary. Null on a user row: their role's default (src/server/daily/summary.ts). */
export const summaryPref = pgEnum("summary_pref", ["email", "push", "both", "none"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/** The allowlist. Email is stored lower-cased; a row with active = false cannot use the app. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    role: userRole("role").notNull(),
    active: boolean("active").notNull().default(true),
    summaryPref: summaryPref("summary_pref"),
    /** The person's own Today choices: { kinds: string[], hideBirthdays: boolean } (src/server/care/today-prefs.ts). */
    todayPrefs: jsonb("today_prefs"),
    /** "I'm away": from and until (Chicago days, inclusive) and the colleague covering. Read-time only; nothing is reassigned (src/server/team/away.ts). */
    awayFrom: date("away_from"),
    awayUntil: date("away_until"),
    coverUserId: uuid("cover_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email), check("users_email_lower", sql`${t.email} = lower(${t.email})`)],
);

/** People cared for who are not in Salesforce. They live only in this app. */
export const outsidePeople = pgTable(
  "outside_people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    /** An optional address, four nullable columns (added in 0011). */
    addressStreet: text("address_street"),
    addressCity: text("address_city"),
    addressState: text("address_state"),
    addressPostalCode: text("address_postal_code"),
    /** Who they are to the congregation, e.g. "mother of Dana Levy, lives in Chicago". */
    note: text("note"),
    linkedSfAccountId: text("linked_sf_account_id"),
    linkedSfContactId: text("linked_sf_contact_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("outside_people_name_idx").on(t.name)],
);

/** A care item is about exactly one person: a Salesforce contact or an outside person. */
export const careItems = pgTable(
  "care_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sfContactId: text("sf_contact_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id),
    sfAccountId: text("sf_account_id"),
    displayName: text("display_name").notNull(),
    category: careCategory("category").notNull(),
    // The column default stays "open" (what code before v2 relies on); new code writes "new" itself.
    status: careStatus("status").notNull().default("open"),
    /** What is going on. Pastoral text: never logged, never in audit detail. */
    summary: text("summary"),
    location: text("location"),
    source: careSource("source").notNull().default("clergy"),
    /** How we learned of it. */
    learnedFrom: text("learned_from"),
    /** A logistics-only line for Mitzvah Corps (max 300). The one care-item text a lead may read. Never on a restricted item; cleared by the note purge. */
    corpsNote: text("corps_note"),
    pausedUntil: date("paused_until"),
    /** Restricted to its owner and the clergy in care_item_access. No role overrides this. */
    restricted: boolean("restricted").notNull().default(false),
    /** Whether other clergy see "in <owner>'s care" (true) or nothing at all (false). */
    restrictedShowsCarer: boolean("restricted_shows_carer").notNull().default(true),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    visibility: careVisibility("visibility").notNull().default("clergy"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // The three columns below belonged to the three-year note purge, which was retired (Daniel, 2026-11-25): care notes
    // are no longer cleared on a timer. Nothing sets keep_notes or notes_unkept_at any more, and nothing clears notes.
    // The columns stay (no destructive migration).
    keepNotes: boolean("keep_notes").notNull().default(false),
    notesUnkeptAt: timestamp("notes_unkept_at", { withTimezone: true }),
    /** When the retired purge cleared this item's note text, if it ever did. */
    notesPurgedAt: timestamp("notes_purged_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("care_items_owner_idx").on(t.ownerUserId),
    index("care_items_contact_idx").on(t.sfContactId),
    index("care_items_status_idx").on(t.status),
    index("care_items_outside_person_idx").on(t.outsidePersonId),
    check("care_items_one_person", sql`num_nonnulls(${t.sfContactId}, ${t.outsidePersonId}) = 1`),
    check("care_items_restricted_clergy_only", sql`not ${t.restricted} or ${t.visibility} = 'clergy'`),
  ],
);

/** The clergy named on a restricted care item. Its owner has access without a row. */
export const careItemAccess = pgTable(
  "care_item_access",
  {
    careItemId: uuid("care_item_id")
      .notNull()
      .references(() => careItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.careItemId, t.userId] }), index("care_item_access_user_idx").on(t.userId)],
);

export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    careItemId: uuid("care_item_id").references(() => careItems.id),
    sfContactId: text("sf_contact_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id),
    sfAccountId: text("sf_account_id"),
    displayName: text("display_name"),
    title: text("title").notNull(),
    dueDate: date("due_date").notNull(),
    // Null = unassigned (e.g. its owner became a caregiver and it is clergy-only work).
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    doneAt: timestamp("done_at", { withTimezone: true }),
    /** The journey run that made this step, if any (src/server/journeys). */
    journeyId: uuid("journey_id").references(() => careItemJourneys.id),
    /** A Mitzvah Corps step: held by a lead, or by the item's owner "for Mitzvah Corps" when there is no lead or the item is restricted. */
    forLead: boolean("for_lead").notNull().default(false),
    /** A one-line outcome a lead adds when completing their step. Free text: cleared by the retention job. */
    outcomeNote: text("outcome_note"),
    /** What the step links to: "meals" (start a Mitzvah Meals page). */
    link: text("link"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("follow_ups_owner_due_idx").on(t.ownerUserId, t.dueDate),
    index("follow_ups_journey_idx").on(t.journeyId),
    index("follow_ups_care_item_idx").on(t.careItemId),
    index("follow_ups_outside_person_idx").on(t.outsidePersonId),
    check("follow_ups_subject", sql`${t.careItemId} is not null or ${t.sfContactId} is not null or ${t.outsidePersonId} is not null`),
    check("follow_ups_one_person", sql`num_nonnulls(${t.sfContactId}, ${t.outsidePersonId}) <= 1`),
  ],
);

export const contactLog = pgTable(
  "contact_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sfContactId: text("sf_contact_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id),
    sfAccountId: text("sf_account_id"),
    displayName: text("display_name").notNull(),
    careItemId: uuid("care_item_id").references(() => careItems.id),
    kind: contactKind("kind").notNull(),
    outcome: contactOutcome("outcome"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    note: text("note"),
    private: boolean("private").notNull().default(false),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contact_log_contact_idx").on(t.sfContactId, t.occurredAt),
    index("contact_log_author_idx").on(t.authorUserId),
    index("contact_log_care_item_idx").on(t.careItemId),
    index("contact_log_outside_person_idx").on(t.outsidePersonId),
    check("contact_log_one_person", sql`num_nonnulls(${t.sfContactId}, ${t.outsidePersonId}) = 1`),
  ],
);

/**
 * The Inbox. Every arrival is a proposal; nothing reaches the care list until
 * clergy accept it. raw_text (the words as they arrived) is KEPT when the proposal is accepted
 * or dismissed (Daniel, 2026-11-25), for clergy only: src/server/care/original-reports.ts. The
 * reading and the intake are still cleared on the decision.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: careSource("channel").notNull(),
    /** Null when no signed-in person sent it: the public form, Salesforce, and a staff request a rabbi must decide. */
    submittedBy: uuid("submitted_by").references(() => users.id),
    submitterLabel: text("submitter_label"),
    rawText: text("raw_text"),
    /** Set on acceptance when the words were written into a note private to the acceptor (a sensitive reading added to an existing item): the kept words are then theirs alone to read, like that note. */
    wordsPrivate: boolean("words_private").notNull().default(false),
    /** The sorted reading (src/server/care/reading.ts). */
    reading: jsonb("reading"),
    /** submitter: only the clergy member who captured it reviews it. clergy: the shared Inbox. */
    reviewScope: reviewScope("review_scope").notNull(),
    status: proposalStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    resultCareItemId: uuid("result_care_item_id").references(() => careItems.id),
    createdAt: createdAt(),
    /** A stable key for an arrival that must never become two proposals (a Salesforce death or birth). It is kept after the decision, so a dismissed proposal is never recreated. */
    externalKey: text("external_key"),
    /** What the sender or the source stated (public form: about, sender, contact; Salesforce: ids). Pastoral: cleared when decided (it holds the sender's name and contact). Never verified. */
    intake: jsonb("intake"),
    /** Public form: "May we tell them you let us know?" yes | no. */
    mayTellThem: text("may_tell_them"),
    /** Public form: the Mi Sheberach consent answer, yes | no | not_sure. Kept after the decision, for the stage that adds the name to the list. */
    miSheberachAnswer: text("mi_sheberach_answer"),
    /** Public form, accepted, and the sender agreed we may say they told us: their name and email, kept (Daniel, 2026-11-25: "Keep everything") for a thank-you from the clergy member's own mail app (src/server/care/reporter.ts). */
    reporterName: text("reporter_name"),
    reporterEmail: text("reporter_email"),
    /** Public form: the sender chose "Practical help from Mitzvah Corps". */
    practical: boolean("practical").notNull().default(false),
    /** Public form, practical, and nothing sensitive: the Mitzvah Corps lead may see the sender's own words (src/server/care/practical.ts). Only ever set false later, never true. */
    leadVisible: boolean("lead_visible").notNull().default(false),
    /** The Mitzvah Corps lead (or a clergy member) who said "I'll take this". First taker wins. */
    takenBy: uuid("taken_by").references(() => users.id),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    /** A volunteer's flag on a task linked to a care item: only those who may open that item review it (a restricted item: its owner and the clergy named on it). Scoping only: never shown, and nothing of the item is copied. */
    scopeCareItemId: uuid("scope_care_item_id").references(() => careItems.id),
  },
  (t) => [index("proposals_status_idx").on(t.status, t.reviewScope), index("proposals_submitter_idx").on(t.submittedBy), uniqueIndex("proposals_external_key_key").on(t.externalKey)],
);

/** Personal capture tokens (the iPhone Shortcut). Only the SHA-256 of a token is stored, plus a short visible prefix. */
export const captureTokens = pgTable(
  "capture_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("capture_tokens_hash_key").on(t.tokenHash), index("capture_tokens_user_idx").on(t.userId)],
);

/**
 * Who did what to which record, and when. detail holds ids, enums and flags only:
 * never note text, summary text or a proposal's raw text (src/server/care/audit.ts).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null only for a change made through a meal page's family link, which has no account (detail.by = "family"). */
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    detail: jsonb("detail"),
  },
  (t) => [index("audit_log_subject_idx").on(t.subjectType, t.subjectId), index("audit_log_at_idx").on(t.at)],
);

/**
 * "Texted this year": one mark per occasion, household and year, shared by the team.
 * subject_id is the Salesforce record the occasion comes from (Contact for a birthday,
 * Account for an anniversary, Yahrzeit__c or Contact for a yahrzeit / shloshim).
 */
export const occasionMarks = pgTable(
  "occasion_marks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occasionType: occasionType("occasion_type").notNull(),
    subjectId: text("subject_id").notNull(),
    sfAccountId: text("sf_account_id").notNull().default(""),
    sfContactId: text("sf_contact_id"),
    year: integer("year").notNull(),
    markedBy: uuid("marked_by")
      .notNull()
      .references(() => users.id),
    markedAt: timestamp("marked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("occasion_marks_key").on(t.occasionType, t.subjectId, t.sfAccountId, t.year), index("occasion_marks_year_idx").on(t.year)],
);

/**
 * A user's own text draft for one occasion type. No row = the default draft in code
 * (src/server/lifecycle/sms.ts). Placeholders are filled in when the link is built.
 */
export const textDrafts = pgTable(
  "text_drafts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    occasionType: occasionType("occasion_type").notNull(),
    body: text("body").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.occasionType] })],
);

/** Salesforce results cached for one America/Chicago day. */
export const sfDayCache = pgTable(
  "sf_day_cache",
  {
    key: text("key").notNull(),
    day: date("day").notNull(),
    data: jsonb("data").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.day] })],
);

// ─── Mitzvah Meals ───────────────────────────────────────────────────────────────────
// A calendar of meal dates for a household, with a public link (no account) and a
// private family link. Nothing of the care record is copied here: a page holds only
// what its organiser typed for it. Access: src/server/access/policy.ts.

export const mealPageStatus = pgEnum("meal_page_status", ["draft", "live", "paused", "ended"]);
export const mealKashrut = pgEnum("meal_kashrut", ["anything", "kosher_style", "vegetarian_or_dairy", "strictly_kosher"]);
export const mealKind = pgEnum("meal_kind", ["dinner", "lunch"]);
export const mealSlotStatus = pgEnum("meal_slot_status", ["open", "withdrawn"]);
export const mealSignupKind = pgEnum("meal_signup_kind", ["cook", "delivery"]);
export const mealFoodType = pgEnum("meal_food_type", ["meat", "dairy", "pareve", "not_sure"]);
export const mealCancelledBy = pgEnum("meal_cancelled_by", ["helper", "organiser", "family"]);
export const mealPausedBy = pgEnum("meal_paused_by", ["organiser", "family"]);

export const mealPages = pgTable(
  "meal_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Stored as given so organisers can re-share the links; looked up by the hash (src/server/meals/tokens.ts).
     * All four are blanked by the purge, thirty days after the page ended: from then on neither link resolves.
     */
    publicToken: text("public_token"),
    publicTokenHash: text("public_token_hash"),
    familyToken: text("family_token"),
    familyTokenHash: text("family_token_hash"),
    /** Shown only to those who fully read the care item; nothing of it is ever exposed through the page. */
    careItemId: uuid("care_item_id").references(() => careItems.id),
    sfContactId: text("sf_contact_id"),
    sfAccountId: text("sf_account_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id),
    /** "the Cohen family", shown as "Mitzvah Meals for the Cohen family". */
    title: text("title").notNull(),
    /** The organiser's short public note. Never the reason for care. */
    note: text("note"),
    status: mealPageStatus("status").notNull().default("draft"),
    /** Who paused it, while it is paused. The family link resumes only a pause the family made. */
    pausedBy: mealPausedBy("paused_by"),
    familyAgreedAt: timestamp("family_agreed_at", { withTimezone: true }),
    familyAgreedBy: uuid("family_agreed_by").references(() => users.id),
    foodFor: text("food_for"),
    kashrut: mealKashrut("kashrut").notNull().default("anything"),
    dietary: text("dietary")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Kept apart from preferences. */
    allergies: text("allergies"),
    dropOffWindow: text("drop_off_window"),
    dropOffInstructions: text("drop_off_instructions"),
    /** Given only to someone who has signed up, and to the organisers. */
    dropOffAddress: text("drop_off_address"),
    dropOffIsHome: boolean("drop_off_is_home").notNull().default(true),
    deliveryPlaces: text("delivery_places"),
    giftCards: text("gift_cards"),
    giftCardEmail: text("gift_card_email"),
    organiserUserId: uuid("organiser_user_id")
      .notNull()
      .references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meal_pages_public_token_hash_key").on(t.publicTokenHash),
    uniqueIndex("meal_pages_family_token_hash_key").on(t.familyTokenHash),
    index("meal_pages_organiser_idx").on(t.organiserUserId),
    index("meal_pages_contact_idx").on(t.sfContactId),
    index("meal_pages_care_item_idx").on(t.careItemId),
    check("meal_pages_one_person", sql`num_nonnulls(${t.sfContactId}, ${t.outsidePersonId}) <= 1`),
    // A page cannot leave draft until the family has agreed.
    check("meal_pages_family_agreed", sql`${t.status} = 'draft' or ${t.familyAgreedAt} is not null`),
  ],
);

export const mealPageOrganisers = pgTable(
  "meal_page_organisers",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => mealPages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.userId] }), index("meal_page_organisers_user_idx").on(t.userId)],
);

export const mealSlots = pgTable(
  "meal_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => mealPages.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    meal: mealKind("meal").notNull().default("dinner"),
    status: mealSlotStatus("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [unique("meal_slots_page_date_meal_key").on(t.pageId, t.date, t.meal)],
);

/**
 * A helper's sign-up for one slot. Notes are cleared by the purge (src/server/meals/purge.ts); name and
 * email are kept, but are nullable as purges before 2026-11-25 cleared them. The manage token is stored hashed.
 */
export const mealSignups = pgTable(
  "meal_signups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => mealSlots.id, { onDelete: "cascade" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Lower case. */
    email: text("email"),
    kind: mealSignupKind("kind").notNull(),
    bringing: text("bringing"),
    foodType: mealFoodType("food_type").notNull().default("not_sure"),
    note: text("note"),
    manageTokenHash: text("manage_token_hash").notNull(),
    /** The helper's tick box: "CRC may ask me to help another family in future". */
    mayContactAgain: boolean("may_contact_again").notNull().default(false),
    /** Set when an organiser booked it on the helper's behalf. */
    bookedBy: uuid("booked_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: mealCancelledBy("cancelled_by"),
    thanksText: text("thanks_text"),
    thankedAt: timestamp("thanked_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meal_signups_manage_token_hash_key").on(t.manageTokenHash),
    // At most one active sign-up per slot: two people cannot take the same night.
    uniqueIndex("meal_signups_one_active_per_slot")
      .on(t.slotId)
      .where(sql`${t.cancelledAt} is null`),
    index("meal_signups_email_idx").on(t.email),
    check("meal_signups_email_lower", sql`${t.email} = lower(${t.email})`),
  ],
);

/** Emails an organiser has blocked from one page. */
export const mealPageBlocks = pgTable(
  "meal_page_blocks",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => mealPages.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    blockedBy: uuid("blocked_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.email] })],
);

/** Hourly counters for the public (no account) functions. Rows are pruned as new windows open. */
export const mealRateLimits = pgTable(
  "meal_rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("meal_rate_limits_window_idx").on(t.windowStart)],
);

// ─── Volunteer tasks ─────────────────────────────────────────────────────────────────
// A small ask posted by a lead or clergy and taken by a volunteer with no account, through a
// secret link (src/server/volunteers). A task never carries anything from a care record.

export const volunteerKind = pgEnum("volunteer_kind", ["visit", "call", "meal", "ride", "shiva_minyan", "errand", "other"]);
export const volunteerTaskStatus = pgEnum("volunteer_task_status", ["open", "done", "cancelled"]);
export const volunteerCancelledBy = pgEnum("volunteer_cancelled_by", ["volunteer", "poster"]);

/** A shiva sheet: one link for several evenings (tasks with group_id) and a "who is bringing what" list. */
export const volunteerGroups = pgTable(
  "volunteer_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicToken: text("public_token"),
    publicTokenHash: text("public_token_hash"),
    /** "the Cohen family". */
    title: text("title").notNull(),
    /** Never shown to volunteers; only clergy who fully see the item see the link. */
    careItemId: uuid("care_item_id").references(() => careItems.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("volunteer_groups_token_hash_key").on(t.publicTokenHash)],
);

/** A poster's board link: all their open tasks on one page. One per person. Stored as given so it can be re-shared; looked up by hash. */
export const volunteerBoards = pgTable(
  "volunteer_boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    token: text("token").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("volunteer_boards_owner_key").on(t.ownerUserId), uniqueIndex("volunteer_boards_token_hash_key").on(t.tokenHash)],
);

/** A repeating task: the group of ordinary tasks made together. Holds no words of its own. */
export const volunteerSeries = pgTable("volunteer_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const volunteerTasks = pgTable(
  "volunteer_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for an evening on a shiva sheet (the sheet has the link). Blanked by the purge. */
    publicToken: text("public_token"),
    publicTokenHash: text("public_token_hash"),
    groupId: uuid("group_id").references(() => volunteerGroups.id, { onDelete: "cascade" }),
    /** The repeating series this occurrence belongs to, if any. */
    seriesId: uuid("series_id").references(() => volunteerSeries.id, { onDelete: "set null" }),
    kind: volunteerKind("kind").notNull(),
    /** A first name or short label: "Ruth", "the Cohen family". */
    forLabel: text("for_label").notNull(),
    /** One or two lines, written by the poster for volunteers. */
    needed: text("needed").notNull(),
    taskDate: date("task_date").notNull(),
    timeWindow: text("time_window"),
    /** Shown only after someone claims. Cleared by the purge thirty days after a cancelled or past task. */
    place: text("place"),
    peopleNeeded: integer("people_needed").notNull().default(1),
    contactLine: text("contact_line"),
    status: volunteerTaskStatus("status").notNull().default("open"),
    /** Never shown to volunteers. */
    careItemId: uuid("care_item_id").references(() => careItems.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    doneAt: timestamp("done_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("volunteer_tasks_token_hash_key").on(t.publicTokenHash),
    index("volunteer_tasks_creator_idx").on(t.createdBy),
    index("volunteer_tasks_group_idx").on(t.groupId),
    index("volunteer_tasks_series_idx").on(t.seriesId),
    index("volunteer_tasks_care_item_idx").on(t.careItemId),
    index("volunteer_tasks_date_idx").on(t.taskDate),
    check("volunteer_tasks_people", sql`${t.peopleNeeded} between 1 and 50`),
  ],
);

/** A volunteer's claim. Name and contact are kept (purges before 2026-11-25 cleared some); notes are cleared by the purge. The personal token is stored only as its hash. */
export const volunteerClaims = pgTable(
  "volunteer_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => volunteerTasks.id, { onDelete: "cascade" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** An email (lower case) or a mobile number, as given. */
    contact: text("contact"),
    /** Lower-cased email, or the digits of a number: how a block recognises the same person. */
    contactKey: text("contact_key"),
    note: text("note"),
    mayAskAgain: boolean("may_ask_again").notNull().default(false),
    /** Null once the purge has made the link dead. */
    manageTokenHash: text("manage_token_hash"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: volunteerCancelledBy("cancelled_by"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    /** The volunteer's one line back to the poster. */
    doneNote: text("done_note"),
    /** When the volunteer last sent "Something a rabbi should know" from their own page. Only the time: the words went to the clergy Inbox as a proposal and are never kept here. */
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    /** Claims made together by one "I can do this every time" share this id; only the first carries a personal link. */
    claimSetId: uuid("claim_set_id"),
    /** An opaque id held in the volunteer's own first-party cookie, so their personal pages can list what they have taken on that device. Never derived from, or matched by, a contact. */
    personRef: uuid("person_ref"),
    createdAt: createdAt(),
  },
  (t) => [
    index("volunteer_claims_set_idx").on(t.claimSetId),
    index("volunteer_claims_person_idx").on(t.personRef),
    uniqueIndex("volunteer_claims_token_hash_key").on(t.manageTokenHash),
    index("volunteer_claims_task_idx").on(t.taskId),
    // Backstop for the check in the claim path: one place per person on a task.
    uniqueIndex("volunteer_claims_one_active_per_contact")
      .on(t.taskId, t.contactKey)
      .where(sql`${t.cancelledAt} is null and ${t.contactKey} is not null`),
  ],
);

/** Contacts a poster has blocked from one task. */
export const volunteerTaskBlocks = pgTable(
  "volunteer_task_blocks",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => volunteerTasks.id, { onDelete: "cascade" }),
    contactKey: text("contact_key").notNull(),
    blockedBy: uuid("blocked_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.contactKey] })],
);

/** "Who is bringing what" on a shiva sheet: a first name and a free line. The poster can remove any. */
export const volunteerBringing = pgTable(
  "volunteer_bringing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => volunteerGroups.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    line: text("line").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("volunteer_bringing_group_idx").on(t.groupId)],
);
// ─── Journeys ────────────────────────────────────────────────────────────────────────
// A journey is a template of steps; starting one on a care item makes ordinary
// follow-ups (follow_ups.journey_id). Access: src/server/access/policy.ts.

/**
 * The four templates, seeded by migration 0007. `steps` is an ordered JSON list
 * (src/server/journeys/templates.ts). Editing one changes only journeys started afterwards.
 */
export const journeyTemplates = pgTable("journey_templates", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  steps: jsonb("steps").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

/** One journey started on one care item. */
export const careItemJourneys = pgTable(
  "care_item_journeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    careItemId: uuid("care_item_id")
      .notNull()
      .references(() => careItems.id),
    templateKey: text("template_key")
      .notNull()
      .references(() => journeyTemplates.key),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    /** The date the steps count from: the date of death, the day it began, the birth. */
    anchorDate: date("anchor_date").notNull(),
    /** The second date some templates use: the funeral, the discharge. */
    secondDate: date("second_date"),
    /** A standing check-in: every so many weeks. */
    intervalWeeks: integer("interval_weeks"),
    /** The Mitzvah Corps lead chosen for its lead steps, if any. */
    leadUserId: uuid("lead_user_id").references(() => users.id),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: uuid("ended_by").references(() => users.id),
  },
  (t) => [
    index("care_item_journeys_item_idx").on(t.careItemId),
    // A journey runs once at a time per item and template.
    uniqueIndex("care_item_journeys_one_running")
      .on(t.careItemId, t.templateKey)
      .where(sql`${t.endedAt} is null`),
    check("care_item_journeys_interval", sql`${t.intervalWeeks} is null or ${t.intervalWeeks} between 1 and 26`),
  ],
);

// ─── The daily job ───────────────────────────────────────────────────────────────────

/** One row per task per run of the daily job: ok, or the error's NAME only, and counts only. */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    task: text("task").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok"),
    errorName: text("error_name"),
    counts: jsonb("counts"),
  },
  (t) => [index("job_runs_task_started_idx").on(t.task, t.startedAt)],
);

/** A person's morning: counts only, never names or text. No row on an empty day. */
export const dailySummaries = pgTable(
  "daily_summaries",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    day: date("day").notNull(),
    overdue: integer("overdue").notNull().default(0),
    dueToday: integer("due_today").notNull().default(0),
    inbox: integer("inbox").notNull().default(0),
    newSteps: integer("new_steps").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

// ─── Mi Sheberach ────────────────────────────────────────────────────────────────────
// The healing-prayers list, read aloud on Shabbat, and its two-way sync with the Healing Prayers
// section of the bima packet (src/server/misheberach). A name here is a public-in-synagogue fact;
// the link to a care item is shown only to those who fully see that item (policy.ts).

export const miSheberachKind = pgEnum("mi_sheberach_kind", ["dated", "standing"]);
export const miSheberachConsent = pgEnum("mi_sheberach_consent", ["confirmed", "not_confirmed", "asked_not_listed"]);
export const miSheberachSource = pgEnum("mi_sheberach_source", ["app", "public_form", "bima_packet"]);
export const miSheberachEndReason = pgEnum("mi_sheberach_end_reason", ["expired", "removed_by_clergy", "removed_in_packet", "recovered", "died", "asked_to_be_removed"]);

export const miSheberachEntries = pgTable(
  "mi_sheberach_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The name as it is read aloud: English, or a Hebrew name with ben or bat. One entry may name two people. */
    name: text("name").notNull(),
    /** The normalised name (src/server/misheberach/line.ts): how a packet line is matched to an entry. */
    nameKey: text("name_key").notNull(),
    sfContactId: text("sf_contact_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id),
    careItemId: uuid("care_item_id").references(() => careItems.id),
    /** Who asked and how they are related, as it is written in the packet: "friend of X", "added by X". */
    askedBy: text("asked_by"),
    dateAdded: date("date_added").notNull(),
    /** A name imported from the packet whose 120 days were already up or nearly: it may not come off before this day, so the "still needed?" prompt can be answered first. */
    keepUntil: date("keep_until"),
    kind: miSheberachKind("kind").notNull().default("dated"),
    consent: miSheberachConsent("consent").notNull().default("not_confirmed"),
    source: miSheberachSource("source").notNull().default("app"),
    /** The packet's asterisk: a special request. */
    specialRequest: boolean("special_request").notNull().default(false),
    /** A packet edit the sync could not place with certainty: a person should look. */
    needsReview: boolean("needs_review").notNull().default(false),
    /** The exact line last written to or read from the packet; null until it has been in the packet. */
    docLine: text("doc_line"),
    createdBy: uuid("created_by").references(() => users.id),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: miSheberachEndReason("ended_reason"),
    endedBy: uuid("ended_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One live entry per name: a second add finds the first.
    uniqueIndex("mi_sheberach_one_live_name").on(t.nameKey).where(sql`${t.endedAt} is null`),
    index("mi_sheberach_name_key_idx").on(t.nameKey),
    index("mi_sheberach_care_item_idx").on(t.careItemId),
    index("mi_sheberach_contact_idx").on(t.sfContactId),
    index("mi_sheberach_outside_idx").on(t.outsidePersonId),
    check("mi_sheberach_ended_pair", sql`(${t.endedAt} is null) = (${t.endedReason} is null)`),
  ],
);

/** The one row of sync state: the last synced snapshot of the packet section, and the last run (counts and an error NAME only). */
export const miSheberachSync = pgTable("mi_sheberach_sync", {
  key: text("key").primaryKey(),
  /** [{ line, entryId }]: the section as it stood after the last successful sync. Never logged. */
  snapshot: jsonb("snapshot"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  ok: boolean("ok"),
  errorName: text("error_name"),
  counts: jsonb("counts"),
  /** The last plan (dry run, or a run that was stopped): what the sync would do, for clergy to read. Names are in it, so it is shown only to clergy and never logged. */
  plan: jsonb("plan"),
  updatedAt: updatedAt(),
});

/**
 * "You might reach out to" suggestions a person set aside for 30 days (src/server/care/suggestions.ts).
 * subject_id is a care item, follow-up or Mi Sheberach entry id; nothing about the person is stored.
 */
export const suggestionDismissals = pgTable(
  "suggestion_dismissals",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.subjectId] })],
);

// ─── Mitzvah Corps roster ────────────────────────────────────────────────────────────
// The people who have said they will help. Seen only by owner, clergy and the lead (src/server/volunteers/roster.ts).
export const corpsMemberStatus = pgEnum("corps_member_status", ["active", "paused", "left", "pending"]);
/** Who ended a membership: the person through their stop link, or a coordinator. A self-stop is undone only by the person asking again AND a coordinator confirming. */
export const corpsStoppedBy = pgEnum("corps_stopped_by", ["self", "coordinator"]);
export const corpsMemberSource = pgEnum("corps_member_source", ["form", "coordinator", "ask_again"]);

export const corpsHowOften = pgEnum("corps_how_often", ["once_a_year", "twice_a_year", "quarterly", "monthly", "as_needed"]);
export const corpsPreferContact = pgEnum("corps_prefer_contact", ["email", "text", "call"]);

export const corpsMembers = pgTable(
  "mitzvah_corps_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firstName: text("first_name").notNull(),
    /** Contact, last name, availability, area and notes are kept after the member leaves (before 2026-11-25 they were deleted 30 days later). */
    lastName: text("last_name"),
    email: text("email"),
    mobile: text("mobile"),
    /** Lower-cased email and the digits of the mobile number: how the same person is recognised across the form, claims and meal sign-ups. */
    emailKey: text("email_key"),
    mobileKey: text("mobile_key"),
    /** What they can do: visits, calls, meals, rides, shiva_minyan, errands, other. */
    canDo: text("can_do")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    availability: text("availability"),
    area: text("area"),
    /** How often they would like to be asked, and how they prefer to hear from us. Both optional. */
    howOften: corpsHowOften("how_often"),
    preferContact: corpsPreferContact("prefer_contact"),
    /** For coordinators. Never medical or pastoral. */
    coordinatorNotes: text("coordinator_notes"),
    status: corpsMemberStatus("status").notNull().default("active"),
    pausedUntil: date("paused_until"),
    source: corpsMemberSource("source").notNull(),
    joinedOn: date("joined_on").notNull(),
    lastHelpedOn: date("last_helped_on"),
    /** Times helped, kept on the row for members whose claims can no longer be matched (those cleared before 2026-11-25). */
    helpedCount: integer("helped_count").notNull().default(0),
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    /** Only the hash of the "stop asking me" link is stored. */
    stopTokenHash: text("stop_token_hash"),
    leftAt: timestamp("left_at", { withTimezone: true }),
    stoppedBy: corpsStoppedBy("stopped_by"),
    /** A /join submission for a contact already on the roster changes nothing but this: a timestamp for coordinators to act on. */
    askedToJoinAgainAt: timestamp("asked_to_join_again_at", { withTimezone: true }),
    contactPurgedAt: timestamp("contact_purged_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("corps_members_email_key").on(t.emailKey).where(sql`${t.emailKey} is not null`),
    uniqueIndex("corps_members_mobile_key").on(t.mobileKey).where(sql`${t.mobileKey} is not null`),
    uniqueIndex("corps_members_stop_token_key").on(t.stopTokenHash).where(sql`${t.stopTokenHash} is not null`),
    index("corps_members_status_idx").on(t.status),
    check("corps_members_contact", sql`${t.contactPurgedAt} is not null or ${t.emailKey} is not null or ${t.mobileKey} is not null`),
  ],
);

/** That a member was asked about a task or sheet (never what was said), so "least recently asked" can order the list. */
export const corpsAsks = pgTable(
  "mitzvah_corps_asks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => corpsMembers.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => volunteerTasks.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => volunteerGroups.id, { onDelete: "cascade" }),
    askedBy: uuid("asked_by")
      .notNull()
      .references(() => users.id),
    askedAt: timestamp("asked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("corps_asks_member_idx").on(t.memberId, t.askedAt), check("corps_asks_one_target", sql`num_nonnulls(${t.taskId}, ${t.groupId}) = 1`)],
);

/**
 * Salted hashes of the contacts of people who stopped or were taken off (never the contact itself), kept even when
 * their details are gone (removed on request, or by a purge before 2026-11-25) so they are not offered again as past
 * helpers or re-added silently.
 */
export const corpsStoppedContacts = pgTable("mitzvah_corps_stopped_contacts", {
  hash: text("hash").primaryKey(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The standing visiting list: members (often in care homes) whom vetted volunteers visit. Clergy decide who is on it; the
 * lead assigns a regular visitor and logs visits. It holds NO health information: a place, a contact line and a note for the visitor.
 * The person is a Salesforce contact or an outside person, with the name cached. Kept after it ends.
 */
export const visitingList = pgTable(
  "visiting_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sfContactId: text("sf_contact_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id),
    displayName: text("display_name").notNull(),
    place: text("place"),
    contactLine: text("contact_line"),
    visitorNote: text("visitor_note"),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    visitorMemberId: uuid("visitor_member_id").references(() => corpsMembers.id, { onDelete: "set null" }),
    visitorSetBy: uuid("visitor_set_by").references(() => users.id),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("visiting_list_one_active_contact").on(t.sfContactId).where(sql`${t.endedAt} is null and ${t.sfContactId} is not null`),
    uniqueIndex("visiting_list_one_active_outside").on(t.outsidePersonId).where(sql`${t.endedAt} is null and ${t.outsidePersonId} is not null`),
    index("visiting_list_visitor_idx").on(t.visitorMemberId),
    check("visiting_list_one_person", sql`num_nonnulls(${t.sfContactId}, ${t.outsidePersonId}) = 1`),
  ],
);

/** One logged visit: the day, who logged it and who went (when they are on the roster). */
export const visitingVisits = pgTable(
  "visiting_visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => visitingList.id, { onDelete: "cascade" }),
    visitedOn: date("visited_on").notNull(),
    loggedBy: uuid("logged_by")
      .notNull()
      .references(() => users.id),
    memberId: uuid("member_id").references(() => corpsMembers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  // One logged visit per entry per day: logging the same day twice is a no-op.
  (t) => [uniqueIndex("visiting_visits_one_per_day").on(t.listId, t.visitedOn)],
);

// ─── referrals to Mitzvah Corps ──────────────────────────────────────────────────────

/**
 * A rabbi refers a person to Mitzvah Corps: what kind of help, whether the person has said yes, and how to reach them.
 * It carries NO health information and no link into care records: no category, no summary, no care item id. The lead
 * sees it on the coordinator home (src/server/volunteers/referrals.ts). Closed rows are kept, with everything written in them (Daniel, 2026-11-25).
 */
export const corpsReferrals = pgTable(
  "corps_referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sfContactId: text("sf_contact_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id),
    displayName: text("display_name").notNull(),
    kind: text("kind").notNull(),
    consent: text("consent").notNull(),
    contactLine: text("contact_line"),
    mayShareAddress: boolean("may_share_address").notNull().default(false),
    alreadyInvolved: text("already_involved"),
    note: text("note"),
    referredBy: uuid("referred_by")
      .notNull()
      .references(() => users.id),
    takenBy: uuid("taken_by").references(() => users.id),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id),
    closedAs: text("closed_as"),
    /** One line the lead may write when closing; the clergy read it on the person's page. */
    outcomeLine: text("outcome_line"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("corps_referrals_one_open_contact").on(t.sfContactId).where(sql`${t.closedAt} is null and ${t.sfContactId} is not null`),
    uniqueIndex("corps_referrals_one_open_outside").on(t.outsidePersonId).where(sql`${t.closedAt} is null and ${t.outsidePersonId} is not null`),
    index("corps_referrals_closed_idx").on(t.closedAt),
    check("corps_referrals_one_person", sql`num_nonnulls(${t.sfContactId}, ${t.outsidePersonId}) = 1`),
    check("corps_referrals_kind", sql`${t.kind} in ('call', 'meal', 'soup', 'visit', 'ride', 'other', 'ask')`),
    check("corps_referrals_consent", sql`${t.consent} in ('yes', 'coordinator_asks', 'rabbi_asks')`),
    check("corps_referrals_closed", sql`(${t.closedAt} is null) = (${t.closedAs} is null) and (${t.closedAs} is null or ${t.closedAs} in ('done', 'declined', 'withdrawn'))`),
  ],
);

// ─── phone notifications (web push) ──────────────────────────────────────────────────

/**
 * One row per browser a person turned notifications on in. The endpoint and keys are secrets of the push
 * service: never logged, never shown. `device_label` is broad ("iPhone", "Mac"), never a user-agent string.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceLabel: text("device_label").notNull(),
    createdAt: createdAt(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_key").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)],
);

/**
 * A person's notification choices. A row exists only once they change something. `kinds` holds only the
 * switches they set (kind -> boolean); a kind not in it follows the default for their role.
 */
export const notificationPrefs = pgTable("notification_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  kinds: jsonb("kinds").notNull().default(sql`'{}'::jsonb`),
  quietEnabled: boolean("quiet_enabled").notNull().default(true),
  /** Hours of the day in America/Chicago, 0 to 23. */
  quietStartHour: integer("quiet_start_hour").notNull().default(21),
  quietEndHour: integer("quiet_end_hour").notNull().default(7),
  /** The urgent kind comes through quiet hours unless the person turns this off. */
  urgentIgnoresQuiet: boolean("urgent_ignores_quiet").notNull().default(true),
  updatedAt: updatedAt(),
});

/**
 * What was sent, for "once per proposal" and "once per 30 minutes". Kind, an opaque key (a proposal id) and a time:
 * nothing about a person. Cleared after 30 days.
 */
export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notification_log_dedupe_key").on(t.userId, t.kind, t.dedupeKey), index("notification_log_user_kind_idx").on(t.userId, t.kind, t.createdAt)],
);

/** Notices held for quiet hours: the kind and a count, one row per person and kind (the latest count wins). */
export const notificationHeld = pgTable(
  "notification_held",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    count: integer("count"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notification_held_user_kind_key").on(t.userId, t.kind)],
);

/**
 * The clergy meeting agenda: a running list for the weekly conversation. An entry is about a care item, a person, or
 * nothing (free text). Who sees it follows its care item (agendaEntryVisibleWhere in src/server/access/policy.ts): an entry
 * on a restricted item exists only for those who fully see the item. `why` and `outcome` are free text. Entries and their
 * words are kept: nothing clears or deletes them on a timer (Daniel, 2026-11-25).
 */
export const agendaEntries = pgTable(
  "agenda_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    careItemId: uuid("care_item_id").references(() => careItems.id, { onDelete: "cascade" }),
    sfContactId: text("sf_contact_id"),
    outsidePersonId: uuid("outside_person_id").references(() => outsidePeople.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    why: text("why"),
    /** The Monday (Chicago) of the meeting week it is for. A carried entry moves to the next Monday. */
    weekOf: date("week_of").notNull(),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    discussedAt: timestamp("discussed_at", { withTimezone: true }),
    discussedBy: uuid("discussed_by").references(() => users.id),
    outcome: text("outcome"),
    createdAt: createdAt(),
  },
  (t) => [index("agenda_entries_week_idx").on(t.weekOf), index("agenda_entries_item_idx").on(t.careItemId), check("agenda_entries_one_person", sql`num_nonnulls(${t.sfContactId}, ${t.outsidePersonId}) <= 1`)],
);

/**
 * Every email the app has sent: what kind, what it was about (an id, never a name) and a keyed hash of the address
 * (never the address). The unique key makes a second identical send a no-op. Rows older than 60 days are deleted by the daily job.
 */
export const emailLog = pgTable(
  "email_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    toHash: text("to_hash").notNull(),
    ok: boolean("ok").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_log_kind_ref_to_key").on(t.kind, t.ref, t.toHash), index("email_log_created_idx").on(t.createdAt)],
);
