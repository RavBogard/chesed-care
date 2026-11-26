ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "scope_care_item_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_claims" ADD COLUMN IF NOT EXISTS "flagged_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "proposals" ADD CONSTRAINT "proposals_scope_care_item_id_care_items_id_fk" FOREIGN KEY ("scope_care_item_id") REFERENCES "public"."care_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
