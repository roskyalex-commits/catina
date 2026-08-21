ALTER TABLE "company_scans" ADD COLUMN "email_pattern" text;--> statement-breakpoint
ALTER TABLE "company_scans" ADD COLUMN "email_pattern_confidence" real;--> statement-breakpoint
ALTER TABLE "company_scans" ADD COLUMN "email_pattern_source" text;--> statement-breakpoint
ALTER TABLE "company_scans" ADD COLUMN "email_pattern_samples" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_scans" ADD COLUMN "mx_provider" text;--> statement-breakpoint
ALTER TABLE "company_scans" ADD COLUMN "catch_all" boolean;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "source_url" text;