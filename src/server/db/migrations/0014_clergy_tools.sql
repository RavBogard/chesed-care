CREATE TABLE "agenda_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"care_item_id" uuid,
	"sf_contact_id" text,
	"outside_person_id" uuid,
	"display_name" text,
	"why" text,
	"week_of" date NOT NULL,
	"added_by" uuid NOT NULL,
	"discussed_at" timestamp with time zone,
	"discussed_by" uuid,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_entries_one_person" CHECK (num_nonnulls("agenda_entries"."sf_contact_id", "agenda_entries"."outside_person_id") <= 1)
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "reporter_name" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "reporter_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "away_from" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "away_until" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cover_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agenda_entries" ADD CONSTRAINT "agenda_entries_care_item_id_care_items_id_fk" FOREIGN KEY ("care_item_id") REFERENCES "public"."care_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_entries" ADD CONSTRAINT "agenda_entries_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_entries" ADD CONSTRAINT "agenda_entries_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_entries" ADD CONSTRAINT "agenda_entries_discussed_by_users_id_fk" FOREIGN KEY ("discussed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_entries_week_idx" ON "agenda_entries" USING btree ("week_of");--> statement-breakpoint
CREATE INDEX "agenda_entries_item_idx" ON "agenda_entries" USING btree ("care_item_id");