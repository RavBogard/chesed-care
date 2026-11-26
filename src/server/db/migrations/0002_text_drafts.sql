CREATE TABLE "text_drafts" (
	"user_id" uuid NOT NULL,
	"occasion_type" "occasion_type" NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "text_drafts_user_id_occasion_type_pk" PRIMARY KEY("user_id","occasion_type")
);
--> statement-breakpoint
ALTER TABLE "text_drafts" ADD CONSTRAINT "text_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;