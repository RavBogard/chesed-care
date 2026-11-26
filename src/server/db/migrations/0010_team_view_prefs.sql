CREATE TABLE "suggestion_dismissals" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestion_dismissals_user_id_kind_subject_id_pk" PRIMARY KEY("user_id","kind","subject_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "today_prefs" jsonb;--> statement-breakpoint
ALTER TABLE "suggestion_dismissals" ADD CONSTRAINT "suggestion_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;