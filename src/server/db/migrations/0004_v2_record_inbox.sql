CREATE TYPE "public"."care_source" AS ENUM('clergy', 'capture', 'connector', 'email', 'form', 'staff', 'voice', 'salesforce');--> statement-breakpoint
CREATE TYPE "public"."contact_outcome" AS ENUM('spoke', 'no_answer', 'left_message', 'visited', 'texted');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."review_scope" AS ENUM('submitter', 'clergy');--> statement-breakpoint
ALTER TYPE "public"."care_category" ADD VALUE 'ongoing';--> statement-breakpoint
ALTER TYPE "public"."care_category" ADD VALUE 'caregiver';--> statement-breakpoint
ALTER TYPE "public"."care_category" ADD VALUE 'life_change';--> statement-breakpoint
ALTER TYPE "public"."care_category" ADD VALUE 'mental_health';--> statement-breakpoint
ALTER TYPE "public"."care_category" ADD VALUE 'simcha';--> statement-breakpoint
ALTER TYPE "public"."care_status" ADD VALUE 'new';--> statement-breakpoint
ALTER TYPE "public"."care_status" ADD VALUE 'paused';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'staff';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'lead';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'senior_staff';--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "care_item_access" (
	"care_item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "care_item_access_care_item_id_user_id_pk" PRIMARY KEY("care_item_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "outside_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"note" text,
	"linked_sf_account_id" text,
	"linked_sf_contact_id" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "care_source" NOT NULL,
	"submitted_by" uuid,
	"submitter_label" text,
	"raw_text" text,
	"reading" jsonb,
	"review_scope" "review_scope" NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"result_care_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follow_ups" DROP CONSTRAINT "follow_ups_subject";--> statement-breakpoint
ALTER TABLE "care_items" ALTER COLUMN "sf_contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_log" ALTER COLUMN "sf_contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "outside_person_id" uuid;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "source" "care_source" DEFAULT 'clergy' NOT NULL;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "learned_from" text;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "paused_until" date;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "restricted_shows_carer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_log" ADD COLUMN "outside_person_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_log" ADD COLUMN "outcome" "contact_outcome";--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "outside_person_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_item_access" ADD CONSTRAINT "care_item_access_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_item_access" ADD CONSTRAINT "care_item_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outside_people" ADD CONSTRAINT "outside_people_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_result_care_item_id_care_items_id_fk" FOREIGN KEY ("result_care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "care_item_access_user_idx" ON "care_item_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outside_people_name_idx" ON "outside_people" USING btree ("name");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status","review_scope");--> statement-breakpoint
CREATE INDEX "proposals_submitter_idx" ON "proposals" USING btree ("submitted_by");--> statement-breakpoint
ALTER TABLE "care_items" ADD CONSTRAINT "care_items_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_log" ADD CONSTRAINT "contact_log_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_items_outside_person_idx" ON "care_items" USING btree ("outside_person_id");--> statement-breakpoint
CREATE INDEX "contact_log_outside_person_idx" ON "contact_log" USING btree ("outside_person_id");--> statement-breakpoint
CREATE INDEX "follow_ups_outside_person_idx" ON "follow_ups" USING btree ("outside_person_id");--> statement-breakpoint
ALTER TABLE "care_items" ADD CONSTRAINT "care_items_one_person" CHECK (num_nonnulls("care_items"."sf_contact_id", "care_items"."outside_person_id") = 1);--> statement-breakpoint
ALTER TABLE "care_items" ADD CONSTRAINT "care_items_restricted_clergy_only" CHECK (not "care_items"."restricted" or "care_items"."visibility" = 'clergy');--> statement-breakpoint
ALTER TABLE "contact_log" ADD CONSTRAINT "contact_log_one_person" CHECK (num_nonnulls("contact_log"."sf_contact_id", "contact_log"."outside_person_id") = 1);--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_one_person" CHECK (num_nonnulls("follow_ups"."sf_contact_id", "follow_ups"."outside_person_id") <= 1);--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_subject" CHECK ("follow_ups"."care_item_id" is not null or "follow_ups"."sf_contact_id" is not null or "follow_ups"."outside_person_id" is not null);