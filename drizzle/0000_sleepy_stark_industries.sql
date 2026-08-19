CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text DEFAULT 'My first agent' NOT NULL,
	"website_url" text NOT NULL,
	"value_prop" text,
	"product_name" text,
	"target_titles" text[] DEFAULT '{}' NOT NULL,
	"target_seniorities" text[] DEFAULT '{}' NOT NULL,
	"industries" text[] DEFAULT '{}' NOT NULL,
	"caen_codes" text[] DEFAULT '{}' NOT NULL,
	"countries" text[] DEFAULT '{"RO"}' NOT NULL,
	"keywords" text[] DEFAULT '{}' NOT NULL,
	"exclusions" text[] DEFAULT '{}' NOT NULL,
	"employee_min" integer,
	"employee_max" integer,
	"revenue_min_ron" numeric,
	"revenue_max_ron" numeric,
	"company_types" text[] DEFAULT '{}' NOT NULL,
	"enabled_signals" text[] DEFAULT '{}' NOT NULL,
	"source_evidence" jsonb,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"email_account_id" uuid,
	"last_launch_at" timestamp with time zone,
	"next_launch_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"auto_send" boolean DEFAULT false NOT NULL,
	"sender_email" text,
	"daily_send_limit" integer DEFAULT 30 NOT NULL,
	"compliance_ack_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text,
	"name" text NOT NULL,
	"country" text,
	"city" text,
	"county" text,
	"website" text,
	"linkedin_url" text,
	"description" text,
	"employee_count" integer,
	"industry" text,
	"tech_stack" text[] DEFAULT '{}' NOT NULL,
	"cui" text,
	"reg_com" text,
	"caen" text,
	"caen_label" text,
	"vat_registered" boolean,
	"vat_on_collection" boolean,
	"e_factura_registered" boolean,
	"insolvency_status" text,
	"onrc_status" text,
	"registration_date" date,
	"revenue_ron" numeric,
	"revenue_prev_ron" numeric,
	"profit_ron" numeric,
	"employees_anaf" integer,
	"financials_year" integer,
	"source" text NOT NULL,
	"last_enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"address" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"daily_sent_count" integer DEFAULT 0 NOT NULL,
	"daily_count_reset_at" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"address" text NOT NULL,
	"is_role_address" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pattern' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"provider" text NOT NULL,
	"mx_valid" boolean,
	"smtp_checked" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"agent_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"title" text,
	"subtitle" text,
	"source_label" text,
	"source_query" text,
	"leads_found" integer DEFAULT 0 NOT NULL,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid,
	"email_id" uuid,
	"score" real DEFAULT 0 NOT NULL,
	"score_breakdown" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"compliance_region" text,
	"rejected_reason" text,
	"fit_feedback" text,
	"source_label" text,
	"source_query" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_members" (
	"list_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "list_members_list_id_lead_id_pk" PRIMARY KEY("list_id","lead_id")
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"sequence_step_id" uuid,
	"channel" text DEFAULT 'email' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"signal_id" uuid,
	"state" text DEFAULT 'drafted' NOT NULL,
	"gmail_draft_id" text,
	"gmail_message_id" text,
	"gmail_thread_id" text,
	"failure_reason" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"home_country" text DEFAULT 'RO' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"title" text,
	"seniority" text,
	"department" text,
	"linkedin_url" text,
	"location" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"provider" text NOT NULL,
	"period_month" text NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"credits_limit" integer,
	"last_call_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"instruction" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb,
	"evidence_url" text,
	"strength" real DEFAULT 0.5 NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"value" text NOT NULL,
	"kind" text DEFAULT 'address' NOT NULL,
	"reason" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_email_account_id_email_accounts_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_members" ADD CONSTRAINT "list_members_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_members" ADD CONSTRAINT "list_members_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sequence_step_id_sequence_steps_id_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "agents_next_launch_idx" ON "agents" USING btree ("status","next_launch_at");--> statement-breakpoint
CREATE INDEX "campaigns_org_idx" ON "campaigns" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_idx" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_cui_idx" ON "companies" USING btree ("cui");--> statement-breakpoint
CREATE INDEX "companies_caen_idx" ON "companies" USING btree ("caen");--> statement-breakpoint
CREATE INDEX "companies_country_city_idx" ON "companies" USING btree ("country","city");--> statement-breakpoint
CREATE INDEX "companies_country_vat_caen_idx" ON "companies" USING btree ("country","vat_registered","caen");--> statement-breakpoint
CREATE UNIQUE INDEX "email_accounts_org_address_idx" ON "email_accounts" USING btree ("org_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_person_address_idx" ON "emails" USING btree ("person_id","address");--> statement-breakpoint
CREATE INDEX "emails_company_idx" ON "emails" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "job_runs_org_kind_idx" ON "job_runs" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "job_runs_agent_started_idx" ON "job_runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_agent_person_idx" ON "leads" USING btree ("agent_id","person_id");--> statement-breakpoint
CREATE INDEX "leads_org_status_score_idx" ON "leads" USING btree ("org_id","status","score");--> statement-breakpoint
CREATE INDEX "leads_agent_created_idx" ON "leads" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "list_members_lead_idx" ON "list_members" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lists_org_name_idx" ON "lists" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_org_state_idx" ON "messages" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "messages_lead_idx" ON "messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "messages_scheduled_idx" ON "messages" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "people_company_idx" ON "people" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_linkedin_idx" ON "people" USING btree ("linkedin_url");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_usage_idx" ON "provider_usage" USING btree ("org_id","provider","period_month");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_step_idx" ON "sequence_steps" USING btree ("campaign_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_dedupe_idx" ON "signals" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "signals_company_detected_idx" ON "signals" USING btree ("company_id","detected_at");--> statement-breakpoint
CREATE INDEX "signals_type_idx" ON "signals" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_org_value_idx" ON "suppressions" USING btree ("org_id","value");