CREATE TYPE "public"."care_category" AS ENUM('illness', 'bereavement', 'birth', 'other');--> statement-breakpoint
CREATE TYPE "public"."care_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."care_visibility" AS ENUM('clergy', 'caregivers');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('call', 'visit', 'text', 'other');--> statement-breakpoint
CREATE TYPE "public"."occasion_type" AS ENUM('yahrzeit', 'shloshim', 'birthday', 'anniversary');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'clergy', 'caregiver');--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_account_provider_key" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "care_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sf_contact_id" text NOT NULL,
	"sf_account_id" text,
	"display_name" text NOT NULL,
	"category" "care_category" NOT NULL,
	"status" "care_status" DEFAULT 'open' NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "care_visibility" DEFAULT 'clergy' NOT NULL,
	"created_by" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sf_contact_id" text NOT NULL,
	"sf_account_id" text,
	"display_name" text NOT NULL,
	"care_item_id" uuid,
	"kind" "contact_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"note" text,
	"private" boolean DEFAULT false NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"care_item_id" uuid,
	"sf_contact_id" text,
	"sf_account_id" text,
	"display_name" text,
	"title" text NOT NULL,
	"due_date" date NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_ups_subject" CHECK ("follow_ups"."care_item_id" is not null or "follow_ups"."sf_contact_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "occasion_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occasion_type" "occasion_type" NOT NULL,
	"subject_id" text NOT NULL,
	"sf_account_id" text DEFAULT '' NOT NULL,
	"sf_contact_id" text,
	"year" integer NOT NULL,
	"marked_by" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occasion_marks_key" UNIQUE("occasion_type","subject_id","sf_account_id","year")
);
--> statement-breakpoint
CREATE TABLE "sf_day_cache" (
	"key" text NOT NULL,
	"day" date NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sf_day_cache_key_day_pk" PRIMARY KEY("key","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_items" ADD CONSTRAINT "care_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_items" ADD CONSTRAINT "care_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_log" ADD CONSTRAINT "contact_log_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_log" ADD CONSTRAINT "contact_log_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occasion_marks" ADD CONSTRAINT "occasion_marks_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_lower_email_key" ON "auth_user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "care_items_owner_idx" ON "care_items" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "care_items_contact_idx" ON "care_items" USING btree ("sf_contact_id");--> statement-breakpoint
CREATE INDEX "care_items_status_idx" ON "care_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "contact_log_contact_idx" ON "contact_log" USING btree ("sf_contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "contact_log_author_idx" ON "contact_log" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "contact_log_care_item_idx" ON "contact_log" USING btree ("care_item_id");--> statement-breakpoint
CREATE INDEX "follow_ups_owner_due_idx" ON "follow_ups" USING btree ("owner_user_id","due_date");--> statement-breakpoint
CREATE INDEX "follow_ups_care_item_idx" ON "follow_ups" USING btree ("care_item_id");--> statement-breakpoint
CREATE INDEX "occasion_marks_year_idx" ON "occasion_marks" USING btree ("year");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");