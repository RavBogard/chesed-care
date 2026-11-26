CREATE TYPE "public"."corps_member_source" AS ENUM('form', 'coordinator', 'ask_again');--> statement-breakpoint
CREATE TYPE "public"."corps_member_status" AS ENUM('active', 'paused', 'left', 'pending');--> statement-breakpoint
CREATE TYPE "public"."corps_stopped_by" AS ENUM('self', 'coordinator');--> statement-breakpoint
CREATE TABLE "mitzvah_corps_asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"task_id" uuid,
	"group_id" uuid,
	"asked_by" uuid NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corps_asks_one_target" CHECK (num_nonnulls("mitzvah_corps_asks"."task_id", "mitzvah_corps_asks"."group_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "mitzvah_corps_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"email" text,
	"mobile" text,
	"email_key" text,
	"mobile_key" text,
	"can_do" text[] DEFAULT '{}'::text[] NOT NULL,
	"availability" text,
	"area" text,
	"coordinator_notes" text,
	"status" "corps_member_status" DEFAULT 'active' NOT NULL,
	"paused_until" date,
	"source" "corps_member_source" NOT NULL,
	"joined_on" date NOT NULL,
	"last_helped_on" date,
	"helped_count" integer DEFAULT 0 NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"stop_token_hash" text,
	"left_at" timestamp with time zone,
	"stopped_by" "corps_stopped_by",
	"asked_to_join_again_at" timestamp with time zone,
	"contact_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corps_members_contact" CHECK ("mitzvah_corps_members"."contact_purged_at" is not null or "mitzvah_corps_members"."email_key" is not null or "mitzvah_corps_members"."mobile_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "mitzvah_corps_stopped_contacts" (
	"hash" text PRIMARY KEY NOT NULL,
	"stopped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "care_items" ADD COLUMN "corps_note" text;--> statement-breakpoint
ALTER TABLE "volunteer_claims" ADD COLUMN "claim_set_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_claims" ADD COLUMN "person_ref" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_asks" ADD CONSTRAINT "mitzvah_corps_asks_member_id_mitzvah_corps_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."mitzvah_corps_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_asks" ADD CONSTRAINT "mitzvah_corps_asks_task_id_volunteer_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."volunteer_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_asks" ADD CONSTRAINT "mitzvah_corps_asks_group_id_volunteer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."volunteer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_asks" ADD CONSTRAINT "mitzvah_corps_asks_asked_by_users_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_series" ADD CONSTRAINT "volunteer_series_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corps_asks_member_idx" ON "mitzvah_corps_asks" USING btree ("member_id","asked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "corps_members_email_key" ON "mitzvah_corps_members" USING btree ("email_key") WHERE "mitzvah_corps_members"."email_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "corps_members_mobile_key" ON "mitzvah_corps_members" USING btree ("mobile_key") WHERE "mitzvah_corps_members"."mobile_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "corps_members_stop_token_key" ON "mitzvah_corps_members" USING btree ("stop_token_hash") WHERE "mitzvah_corps_members"."stop_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "corps_members_status_idx" ON "mitzvah_corps_members" USING btree ("status");--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD CONSTRAINT "volunteer_tasks_series_id_volunteer_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."volunteer_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "volunteer_claims_set_idx" ON "volunteer_claims" USING btree ("claim_set_id");--> statement-breakpoint
CREATE INDEX "volunteer_claims_person_idx" ON "volunteer_claims" USING btree ("person_ref");--> statement-breakpoint
CREATE INDEX "volunteer_tasks_series_idx" ON "volunteer_tasks" USING btree ("series_id");