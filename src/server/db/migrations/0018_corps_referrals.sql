CREATE TABLE "corps_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sf_contact_id" text,
	"outside_person_id" uuid,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"consent" text NOT NULL,
	"contact_line" text,
	"may_share_address" boolean DEFAULT false NOT NULL,
	"already_involved" text,
	"note" text,
	"referred_by" uuid NOT NULL,
	"taken_by" uuid,
	"taken_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_as" text,
	"outcome_line" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corps_referrals_one_person" CHECK (num_nonnulls("corps_referrals"."sf_contact_id", "corps_referrals"."outside_person_id") = 1),
	CONSTRAINT "corps_referrals_kind" CHECK ("corps_referrals"."kind" in ('call', 'meal', 'soup', 'visit', 'ride', 'other', 'ask')),
	CONSTRAINT "corps_referrals_consent" CHECK ("corps_referrals"."consent" in ('yes', 'coordinator_asks', 'rabbi_asks')),
	CONSTRAINT "corps_referrals_closed" CHECK (("corps_referrals"."closed_at" is null) = ("corps_referrals"."closed_as" is null) and ("corps_referrals"."closed_as" is null or "corps_referrals"."closed_as" in ('done', 'declined', 'withdrawn')))
);
--> statement-breakpoint
ALTER TABLE "corps_referrals" ADD CONSTRAINT "corps_referrals_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corps_referrals" ADD CONSTRAINT "corps_referrals_referred_by_users_id_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corps_referrals" ADD CONSTRAINT "corps_referrals_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corps_referrals" ADD CONSTRAINT "corps_referrals_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "corps_referrals_one_open_contact" ON "corps_referrals" USING btree ("sf_contact_id") WHERE "corps_referrals"."closed_at" is null and "corps_referrals"."sf_contact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "corps_referrals_one_open_outside" ON "corps_referrals" USING btree ("outside_person_id") WHERE "corps_referrals"."closed_at" is null and "corps_referrals"."outside_person_id" is not null;--> statement-breakpoint
CREATE INDEX "corps_referrals_closed_idx" ON "corps_referrals" USING btree ("closed_at");