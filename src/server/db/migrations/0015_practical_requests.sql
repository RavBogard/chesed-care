ALTER TABLE "proposals" ADD COLUMN "practical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "lead_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "taken_by" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "taken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;