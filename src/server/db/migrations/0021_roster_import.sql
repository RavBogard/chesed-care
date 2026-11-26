ALTER TYPE "public"."corps_member_source" ADD VALUE 'import';--> statement-breakpoint
ALTER TYPE "public"."volunteer_kind" ADD VALUE 'shiva_help';--> statement-breakpoint
ALTER TYPE "public"."volunteer_kind" ADD VALUE 'delivery';--> statement-breakpoint
ALTER TYPE "public"."volunteer_kind" ADD VALUE 'pet_care';--> statement-breakpoint
ALTER TYPE "public"."volunteer_kind" ADD VALUE 'tech_help';--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" DROP CONSTRAINT "corps_members_contact";--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ALTER COLUMN "consent_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "emails_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "import_sources" text[];--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "not_volunteered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "import_fingerprints" text[];--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "emails_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "intro_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "import_history" text;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "import_details" jsonb;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "import_hash" text;--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD CONSTRAINT "corps_members_contact" CHECK ("mitzvah_corps_members"."contact_purged_at" is not null or "mitzvah_corps_members"."email_key" is not null or "mitzvah_corps_members"."mobile_key" is not null or "mitzvah_corps_members"."imported_at" is not null);