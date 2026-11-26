CREATE TYPE "public"."volunteer_cancelled_by" AS ENUM('volunteer', 'poster');--> statement-breakpoint
CREATE TYPE "public"."volunteer_kind" AS ENUM('visit', 'call', 'meal', 'ride', 'shiva_minyan', 'errand', 'other');--> statement-breakpoint
CREATE TYPE "public"."volunteer_task_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "volunteer_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_bringing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"line" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"contact" text,
	"contact_key" text,
	"note" text,
	"may_ask_again" boolean DEFAULT false NOT NULL,
	"manage_token_hash" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" "volunteer_cancelled_by",
	"done_at" timestamp with time zone,
	"done_note" text,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_token" text,
	"public_token_hash" text,
	"title" text NOT NULL,
	"care_item_id" uuid,
	"created_by" uuid NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_task_blocks" (
	"task_id" uuid NOT NULL,
	"contact_key" text NOT NULL,
	"blocked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_task_blocks_task_id_contact_key_pk" PRIMARY KEY("task_id","contact_key")
);
--> statement-breakpoint
CREATE TABLE "volunteer_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_token" text,
	"public_token_hash" text,
	"group_id" uuid,
	"kind" "volunteer_kind" NOT NULL,
	"for_label" text NOT NULL,
	"needed" text NOT NULL,
	"task_date" date NOT NULL,
	"time_window" text,
	"place" text,
	"people_needed" integer DEFAULT 1 NOT NULL,
	"contact_line" text,
	"status" "volunteer_task_status" DEFAULT 'open' NOT NULL,
	"care_item_id" uuid,
	"created_by" uuid NOT NULL,
	"done_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_tasks_people" CHECK ("volunteer_tasks"."people_needed" between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "volunteer_boards" ADD CONSTRAINT "volunteer_boards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_bringing" ADD CONSTRAINT "volunteer_bringing_group_id_volunteer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."volunteer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_claims" ADD CONSTRAINT "volunteer_claims_task_id_volunteer_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."volunteer_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_groups" ADD CONSTRAINT "volunteer_groups_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_groups" ADD CONSTRAINT "volunteer_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_task_blocks" ADD CONSTRAINT "volunteer_task_blocks_task_id_volunteer_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."volunteer_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_task_blocks" ADD CONSTRAINT "volunteer_task_blocks_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD CONSTRAINT "volunteer_tasks_group_id_volunteer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."volunteer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD CONSTRAINT "volunteer_tasks_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD CONSTRAINT "volunteer_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_boards_owner_key" ON "volunteer_boards" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_boards_token_hash_key" ON "volunteer_boards" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "volunteer_bringing_group_idx" ON "volunteer_bringing" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_claims_token_hash_key" ON "volunteer_claims" USING btree ("manage_token_hash");--> statement-breakpoint
CREATE INDEX "volunteer_claims_task_idx" ON "volunteer_claims" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_claims_one_active_per_contact" ON "volunteer_claims" USING btree ("task_id","contact_key") WHERE "volunteer_claims"."cancelled_at" is null and "volunteer_claims"."contact_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_groups_token_hash_key" ON "volunteer_groups" USING btree ("public_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_tasks_token_hash_key" ON "volunteer_tasks" USING btree ("public_token_hash");--> statement-breakpoint
CREATE INDEX "volunteer_tasks_creator_idx" ON "volunteer_tasks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "volunteer_tasks_group_idx" ON "volunteer_tasks" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "volunteer_tasks_care_item_idx" ON "volunteer_tasks" USING btree ("care_item_id");--> statement-breakpoint
CREATE INDEX "volunteer_tasks_date_idx" ON "volunteer_tasks" USING btree ("task_date");