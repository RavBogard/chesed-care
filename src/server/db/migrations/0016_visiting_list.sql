CREATE TYPE "public"."corps_how_often" AS ENUM('once_a_year', 'twice_a_year', 'quarterly', 'monthly', 'as_needed');--> statement-breakpoint
CREATE TYPE "public"."corps_prefer_contact" AS ENUM('email', 'text', 'call');--> statement-breakpoint
CREATE TABLE "visiting_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sf_contact_id" text,
	"outside_person_id" uuid,
	"display_name" text NOT NULL,
	"place" text,
	"contact_line" text,
	"visitor_note" text,
	"added_by" uuid NOT NULL,
	"visitor_member_id" uuid,
	"visitor_set_by" uuid,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visiting_list_one_person" CHECK (num_nonnulls("visiting_list"."sf_contact_id", "visiting_list"."outside_person_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "visiting_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"visited_on" date NOT NULL,
	"logged_by" uuid NOT NULL,
	"member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "how_often" "corps_how_often";--> statement-breakpoint
ALTER TABLE "mitzvah_corps_members" ADD COLUMN "prefer_contact" "corps_prefer_contact";--> statement-breakpoint
ALTER TABLE "visiting_list" ADD CONSTRAINT "visiting_list_outside_person_id_outside_people_id_fk" FOREIGN KEY ("outside_person_id") REFERENCES "public"."outside_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visiting_list" ADD CONSTRAINT "visiting_list_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visiting_list" ADD CONSTRAINT "visiting_list_visitor_member_id_mitzvah_corps_members_id_fk" FOREIGN KEY ("visitor_member_id") REFERENCES "public"."mitzvah_corps_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visiting_list" ADD CONSTRAINT "visiting_list_visitor_set_by_users_id_fk" FOREIGN KEY ("visitor_set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visiting_visits" ADD CONSTRAINT "visiting_visits_list_id_visiting_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."visiting_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visiting_visits" ADD CONSTRAINT "visiting_visits_logged_by_users_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visiting_visits" ADD CONSTRAINT "visiting_visits_member_id_mitzvah_corps_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."mitzvah_corps_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visiting_list_one_active_contact" ON "visiting_list" USING btree ("sf_contact_id") WHERE "visiting_list"."ended_at" is null and "visiting_list"."sf_contact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "visiting_list_one_active_outside" ON "visiting_list" USING btree ("outside_person_id") WHERE "visiting_list"."ended_at" is null and "visiting_list"."outside_person_id" is not null;--> statement-breakpoint
CREATE INDEX "visiting_list_visitor_idx" ON "visiting_list" USING btree ("visitor_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visiting_visits_one_per_day" ON "visiting_visits" USING btree ("list_id","visited_on");