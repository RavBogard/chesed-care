CREATE TYPE "public"."meal_cancelled_by" AS ENUM('helper', 'organiser', 'family');--> statement-breakpoint
CREATE TYPE "public"."meal_food_type" AS ENUM('meat', 'dairy', 'pareve', 'not_sure');--> statement-breakpoint
CREATE TYPE "public"."meal_kashrut" AS ENUM('anything', 'kosher_style', 'vegetarian_or_dairy', 'strictly_kosher');--> statement-breakpoint
CREATE TYPE "public"."meal_kind" AS ENUM('dinner', 'lunch');--> statement-breakpoint
CREATE TYPE "public"."meal_page_status" AS ENUM('draft', 'live', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."meal_paused_by" AS ENUM('organiser', 'family');--> statement-breakpoint
CREATE TYPE "public"."meal_signup_kind" AS ENUM('cook', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."meal_slot_status" AS ENUM('open', 'withdrawn');--> statement-breakpoint
CREATE TABLE "meal_page_blocks" (
	"page_id" uuid NOT NULL,
	"email" text NOT NULL,
	"blocked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_page_blocks_page_id_email_pk" PRIMARY KEY("page_id","email")
);
--> statement-breakpoint
CREATE TABLE "meal_page_organisers" (
	"page_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "meal_page_organisers_page_id_user_id_pk" PRIMARY KEY("page_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "meal_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_token" text,
	"public_token_hash" text,
	"family_token" text,
	"family_token_hash" text,
	"care_item_id" uuid,
	"sf_contact_id" text,
	"sf_account_id" text,
	"outside_person_id" uuid,
	"title" text NOT NULL,
	"note" text,
	"status" "meal_page_status" DEFAULT 'draft' NOT NULL,
	"paused_by" "meal_paused_by",
	"family_agreed_at" timestamp with time zone,
	"family_agreed_by" uuid,
	"food_for" text,
	"kashrut" "meal_kashrut" DEFAULT 'anything' NOT NULL,
	"dietary" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergies" text,
	"drop_off_window" text,
	"drop_off_instructions" text,
	"drop_off_address" text,
	"drop_off_is_home" boolean DEFAULT true NOT NULL,
	"delivery_places" text,
	"gift_cards" text,
	"gift_card_email" text,
	"organiser_user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_pages_one_person" CHECK (num_nonnulls("meal_pages"."sf_contact_id", "meal_pages"."outside_person_id") <= 1),
	CONSTRAINT "meal_pages_family_agreed" CHECK ("meal_pages"."status" = 'draft' or "meal_pages"."family_agreed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "meal_rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "meal_rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "meal_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"kind" "meal_signup_kind" NOT NULL,
	"bringing" text,
	"food_type" "meal_food_type" DEFAULT 'not_sure' NOT NULL,
	"note" text,
	"manage_token_hash" text NOT NULL,
	"may_contact_again" boolean DEFAULT false NOT NULL,
	"booked_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" "meal_cancelled_by",
	"thanks_text" text,
	"thanked_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_signups_email_lower" CHECK ("meal_signups"."email" = lower("meal_signups"."email"))
);
--> statement-breakpoint
CREATE TABLE "meal_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"date" date NOT NULL,
	"meal" "meal_kind" DEFAULT 'dinner' NOT NULL,
	"status" "meal_slot_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_slots_page_date_meal_key" UNIQUE("page_id","date","meal")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_page_blocks" ADD CONSTRAINT "meal_page_blocks_page_id_meal_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."meal_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_page_blocks" ADD CONSTRAINT "meal_page_blocks_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_page_organisers" ADD CONSTRAINT "meal_page_organisers_page_id_meal_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."meal_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_page_organisers" ADD CONSTRAINT "meal_page_organisers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_pages" ADD CONSTRAINT "meal_pages_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_pages" ADD CONSTRAINT "meal_pages_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_pages" ADD CONSTRAINT "meal_pages_family_agreed_by_users_id_fk" FOREIGN KEY ("family_agreed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_pages" ADD CONSTRAINT "meal_pages_organiser_user_id_users_id_fk" FOREIGN KEY ("organiser_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_pages" ADD CONSTRAINT "meal_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_signups" ADD CONSTRAINT "meal_signups_slot_id_meal_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."meal_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_signups" ADD CONSTRAINT "meal_signups_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_slots" ADD CONSTRAINT "meal_slots_page_id_meal_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."meal_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_page_organisers_user_idx" ON "meal_page_organisers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_pages_public_token_hash_key" ON "meal_pages" USING btree ("public_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_pages_family_token_hash_key" ON "meal_pages" USING btree ("family_token_hash");--> statement-breakpoint
CREATE INDEX "meal_pages_organiser_idx" ON "meal_pages" USING btree ("organiser_user_id");--> statement-breakpoint
CREATE INDEX "meal_pages_contact_idx" ON "meal_pages" USING btree ("sf_contact_id");--> statement-breakpoint
CREATE INDEX "meal_pages_care_item_idx" ON "meal_pages" USING btree ("care_item_id");--> statement-breakpoint
CREATE INDEX "meal_rate_limits_window_idx" ON "meal_rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_signups_manage_token_hash_key" ON "meal_signups" USING btree ("manage_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_signups_one_active_per_slot" ON "meal_signups" USING btree ("slot_id") WHERE "meal_signups"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "meal_signups_email_idx" ON "meal_signups" USING btree ("email");