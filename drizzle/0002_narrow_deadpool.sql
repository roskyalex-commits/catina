CREATE TABLE "company_scans" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"tech_stack" text[] DEFAULT '{}' NOT NULL,
	"pricing_page_url" text,
	"pricing_page_hash" text,
	"careers_page_url" text,
	"careers_job_titles" text[] DEFAULT '{}' NOT NULL,
	"revenue_ron" numeric,
	"vat_registered" boolean,
	"keyword_hits" jsonb,
	"source_results" jsonb,
	"scan_status" text DEFAULT 'ok' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_scans" ADD CONSTRAINT "company_scans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_scans_scanned_idx" ON "company_scans" USING btree ("scanned_at");