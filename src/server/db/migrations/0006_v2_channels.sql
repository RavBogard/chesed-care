ALTER TYPE "public"."care_source" ADD VALUE 'shortcut';--> statement-breakpoint
CREATE TABLE "capture_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "intake" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "may_tell_them" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "mi_sheberach_answer" text;--> statement-breakpoint
ALTER TABLE "capture_tokens" ADD CONSTRAINT "capture_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capture_tokens_hash_key" ON "capture_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "capture_tokens_user_idx" ON "capture_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_external_key_key" ON "proposals" USING btree ("external_key");