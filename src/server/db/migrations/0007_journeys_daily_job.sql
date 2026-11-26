CREATE TYPE "public"."summary_pref" AS ENUM('email', 'push', 'both', 'none');--> statement-breakpoint
CREATE TABLE "care_item_journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"care_item_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anchor_date" date NOT NULL,
	"second_date" date,
	"interval_weeks" integer,
	"lead_user_id" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "care_item_journeys_interval" CHECK ("care_item_journeys"."interval_weeks" is null or "care_item_journeys"."interval_weeks" between 1 and 26)
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"overdue" integer DEFAULT 0 NOT NULL,
	"due_today" integer DEFAULT 0 NOT NULL,
	"inbox" integer DEFAULT 0 NOT NULL,
	"new_steps" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_summaries_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"error_name" text,
	"counts" jsonb
);
--> statement-breakpoint
CREATE TABLE "journey_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"steps" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "keep_notes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "notes_unkept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "notes_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "journey_id" uuid;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "for_lead" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "outcome_note" text;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "link" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "summary_pref" "summary_pref";--> statement-breakpoint
ALTER TABLE "care_item_journeys" ADD CONSTRAINT "care_item_journeys_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_item_journeys" ADD CONSTRAINT "care_item_journeys_template_key_journey_templates_key_fk" FOREIGN KEY ("template_key") REFERENCES "public"."journey_templates"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_item_journeys" ADD CONSTRAINT "care_item_journeys_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_item_journeys" ADD CONSTRAINT "care_item_journeys_lead_user_id_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_item_journeys" ADD CONSTRAINT "care_item_journeys_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_templates" ADD CONSTRAINT "journey_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_item_journeys_item_idx" ON "care_item_journeys" USING btree ("care_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "care_item_journeys_one_running" ON "care_item_journeys" USING btree ("care_item_id","template_key") WHERE "care_item_journeys"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "job_runs_task_started_idx" ON "job_runs" USING btree ("task","started_at");--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_journey_id_care_item_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."care_item_journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_ups_journey_idx" ON "follow_ups" USING btree ("journey_id");--> statement-breakpoint
-- The four journey templates, as drafted 2026-11-24 (src/server/journeys/templates.ts DEFAULT_TEMPLATES; a test keeps the two equal).
INSERT INTO "journey_templates" ("key", "name", "steps") VALUES
('bereavement_year', 'Bereavement year', $steps$[{"id":"call_on_hearing","title":"Call on hearing","who":"clergy","rule":{"kind":"days","days":0}},{"id":"funeral_shiva_details","title":"Record the funeral and shiva details","who":"clergy","rule":{"kind":"days","days":0}},{"id":"shiva_visit","title":"Shiva visit","who":"clergy","rule":{"kind":"days","days":2}},{"id":"call_week_two","title":"Call in the second week","who":"clergy","rule":{"kind":"days","days":10}},{"id":"shloshim","title":"Shloshim: be in touch","who":"clergy","rule":{"kind":"days","days":30}},{"id":"plan_unveiling","title":"Plan the unveiling","who":"clergy","rule":{"kind":"months","months":11}},{"id":"note_high_holidays","title":"A note before the first High Holidays without them","who":"clergy","rule":{"kind":"before_rosh_hashana","days":14}},{"id":"note_pesach","title":"A note before the first Pesach without them","who":"clergy","rule":{"kind":"before_pesach","days":14}},{"id":"call_first_yahrzeit","title":"Call before the first yahrzeit","who":"clergy","rule":{"kind":"before_first_yahrzeit","days":7}},{"id":"arrange_meals","title":"Arrange meals","who":"lead","rule":{"kind":"days","days":0},"link":"meals"},{"id":"arrange_minyan","title":"Arrange the shiva minyan","who":"lead","rule":{"kind":"days","days":0}},{"id":"check_in_month_3","title":"Check-in call, three months on","who":"lead","rule":{"kind":"months","months":3}},{"id":"check_in_month_6","title":"Check-in call, six months on","who":"lead","rule":{"kind":"months","months":6}}]$steps$::jsonb),
('illness', 'Illness and hospital', $steps$[{"id":"visit_or_call","title":"Visit or call","who":"clergy","rule":{"kind":"days","days":0}},{"id":"ask_meals_rides","title":"Ask about meals, rides and the Mi Sheberach list","who":"clergy","rule":{"kind":"days","days":1}},{"id":"after_discharge","title":"Check in after discharge","who":"clergy","rule":{"kind":"after_second","days":0}},{"id":"week_after_discharge","title":"Check in, one week after discharge","who":"clergy","rule":{"kind":"after_second","days":7}},{"id":"three_weeks_after_discharge","title":"Check in, three weeks after discharge","who":"clergy","rule":{"kind":"after_second","days":21}},{"id":"close_or_continue","title":"Close this care, or keep going?","who":"clergy","rule":{"kind":"days","days":42}}]$steps$::jsonb),
('standing', 'Standing check-in', $steps$[{"id":"be_in_touch","title":"Be in touch","who":"clergy","rule":{"kind":"every"}}]$steps$::jsonb),
('new_baby', 'New baby and simchas', $steps$[{"id":"mazal_tov_call","title":"Mazal tov call","who":"clergy","rule":{"kind":"days","days":0}},{"id":"ask_naming_bris","title":"Ask about the naming or bris","who":"clergy","rule":{"kind":"days","days":3}},{"id":"meals_for_parents","title":"Arrange meals for the parents","who":"lead","rule":{"kind":"days","days":0},"link":"meals"},{"id":"check_in_month_3","title":"Check in, three months on","who":"clergy","rule":{"kind":"months","months":3}}]$steps$::jsonb);
