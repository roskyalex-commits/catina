ALTER TABLE "agents" ADD COLUMN "competitor_tech" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "competitor_names" text[] DEFAULT '{}' NOT NULL;