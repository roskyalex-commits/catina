ALTER TABLE "agents" ADD COLUMN "industry_keys" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "caen_codes_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill, hand-added to the generated migration.
--
-- Every agent that already carries CAEN codes got them from a model, before
-- industries derived them. Deriving over the top would silently change what a
-- working agent targets, so those lists are pinned as user-owned and the first
-- normalisation pass leaves them alone. A user who wants derived codes clears
-- the flag from the wizard.
UPDATE "agents" SET "caen_codes_overridden" = true WHERE cardinality("caen_codes") > 0;
