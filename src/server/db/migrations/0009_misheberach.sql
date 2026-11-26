CREATE TYPE "public"."mi_sheberach_consent" AS ENUM('confirmed', 'not_confirmed', 'asked_not_listed');--> statement-breakpoint
CREATE TYPE "public"."mi_sheberach_end_reason" AS ENUM('expired', 'removed_by_clergy', 'removed_in_packet', 'recovered', 'died', 'asked_to_be_removed');--> statement-breakpoint
CREATE TYPE "public"."mi_sheberach_kind" AS ENUM('dated', 'standing');--> statement-breakpoint
CREATE TYPE "public"."mi_sheberach_source" AS ENUM('app', 'public_form', 'bima_packet');--> statement-breakpoint
CREATE TABLE "mi_sheberach_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"sf_contact_id" text,
	"outside_person_id" uuid,
	"care_item_id" uuid,
	"asked_by" text,
	"date_added" date NOT NULL,
	"keep_until" date,
	"kind" "mi_sheberach_kind" DEFAULT 'dated' NOT NULL,
	"consent" "mi_sheberach_consent" DEFAULT 'not_confirmed' NOT NULL,
	"source" "mi_sheberach_source" DEFAULT 'app' NOT NULL,
	"special_request" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"doc_line" text,
	"created_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_reason" "mi_sheberach_end_reason",
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mi_sheberach_ended_pair" CHECK (("mi_sheberach_entries"."ended_at" is null) = ("mi_sheberach_entries"."ended_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "mi_sheberach_sync" (
	"key" text PRIMARY KEY NOT NULL,
	"snapshot" jsonb,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"ok" boolean,
	"error_name" text,
	"counts" jsonb,
	"plan" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mi_sheberach_entries" ADD CONSTRAINT "mi_sheberach_entries_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mi_sheberach_entries" ADD CONSTRAINT "mi_sheberach_entries_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mi_sheberach_entries" ADD CONSTRAINT "mi_sheberach_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mi_sheberach_entries" ADD CONSTRAINT "mi_sheberach_entries_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mi_sheberach_one_live_name" ON "mi_sheberach_entries" USING btree ("name_key") WHERE "mi_sheberach_entries"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "mi_sheberach_name_key_idx" ON "mi_sheberach_entries" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "mi_sheberach_care_item_idx" ON "mi_sheberach_entries" USING btree ("care_item_id");--> statement-breakpoint
CREATE INDEX "mi_sheberach_contact_idx" ON "mi_sheberach_entries" USING btree ("sf_contact_id");--> statement-breakpoint
CREATE INDEX "mi_sheberach_outside_idx" ON "mi_sheberach_entries" USING btree ("outside_person_id");