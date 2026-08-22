/**
 * Cătină database schema.
 *
 * Drizzle is used for schema definition + migration generation only. At runtime
 * inside Cloudflare Workers we read/write through `@supabase/supabase-js` over
 * PostgREST, so that Postgres RLS is enforced with the caller's JWT rather than
 * bypassed by a service-role connection. See `src/lib/supabase/`.
 *
 * Every tenant-owned table carries `orgId`, and every one of them has an RLS
 * policy in `drizzle/policies.sql`. A table without `orgId` is either global
 * reference data (`companies`) or auth-owned.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ tenancy */

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Drives compliance rules and default sourcing adapters. */
  homeCountry: text("home_country").notNull().default("RO"),
  plan: text("plan").notNull().default("free"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Membership links a Supabase `auth.users` row to an org. We deliberately do
 * not mirror the users table — Supabase owns it.
 */
export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index("memberships_user_idx").on(t.userId),
  ],
);

/* --------------------------------------------------------------------- ICP */

/**
 * Output of the onboarding "paste your website URL" step, after user edits.
 * `sourceEvidence` keeps the raw page snippets Claude reasoned over so the ICP
 * is auditable rather than a black box.
 */
/**
 * An agent: a named, scheduled worker that sources leads against one targeting
 * profile and (optionally) drafts outreach for them.
 *
 * This table was `icp_profiles`. The rename is the product model catching up
 * with the UI — the user never thinks about "a profile", they think about an
 * agent that is running, paused, or about to launch. Every targeting field was
 * already here; only the lifecycle columns are new.
 */
export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("My first agent"),
    websiteUrl: text("website_url").notNull(),

    valueProp: text("value_prop"),
    /** Short label for the offering, used in outreach copy. */
    productName: text("product_name"),
    /** e.g. ["CEO", "Founder", "Marketing Director"] */
    targetTitles: text("target_titles").array().notNull().default([]),
    /** e.g. ["c_level", "vp", "director"] */
    targetSeniorities: text("target_seniorities").array().notNull().default([]),
    /** Free text, in the seller's own words. The only thing a non-RO market has. */
    industries: text("industries").array().notNull().default([]),
    /** Keys from `industry-definitions.ts` — the load-bearing targeting field. */
    industryKeys: text("industry_keys").array().notNull().default([]),
    /**
     * Romanian CAEN activity codes — the RO-native targeting axis, and still
     * what the sourcing query filters on.
     *
     * Derived from `industryKeys` at the ICP boundary rather than stored
     * independently, so a row and a live query cannot disagree about what the
     * agent targets.
     */
    caenCodes: text("caen_codes").array().notNull().default([]),
    /**
     * The user edited the code list by hand; stop deriving it.
     *
     * Backfilled true for every agent that already had codes, because those
     * were produced by a model rather than by an industry choice and silently
     * replacing them would change what a working agent targets.
     */
    caenCodesOverridden: boolean("caen_codes_overridden").notNull().default(false),
    countries: text("countries").array().notNull().default(["RO"]),
    keywords: text("keywords").array().notNull().default([]),
    /**
     * Competing products to look for on a prospect's site.
     *
     * Split in two because the detections are not equally trustworthy:
     * `competitorTech` holds names from `DETECTABLE_TECH` that
     * `fingerprintTech` can confirm from markup, while `competitorNames` is
     * everything else and can only be matched as prose. Collapsing them into
     * one column would mean the UI cannot tell a user which of their
     * competitors it can actually spot.
     */
    competitorTech: text("competitor_tech").array().notNull().default([]),
    competitorNames: text("competitor_names").array().notNull().default([]),
    exclusions: text("exclusions").array().notNull().default([]),

    employeeMin: integer("employee_min"),
    employeeMax: integer("employee_max"),
    revenueMinRon: numeric("revenue_min_ron"),
    revenueMaxRon: numeric("revenue_max_ron"),

    /** e.g. ["smb", "ecommerce"] — from COMPANY_TYPES. */
    companyTypes: text("company_types").array().notNull().default([]),

    /** Which SignalSource keys this agent subscribes to. */
    enabledSignals: text("enabled_signals").array().notNull().default([]),
    /**
     * What the website analysis actually read, plus the assumptions it had to
     * make. Display-only and never queried, so it stays jsonb rather than
     * earning columns.
     */
    sourceEvidence: jsonb("source_evidence"),
    /** 0..1 — how well the site supported the inference. Drives UI nudges. */
    confidence: real("confidence").notNull().default(0.5),

    // --- lifecycle ---
    status: text("status", { enum: ["draft", "active", "paused"] })
      .notNull()
      .default("draft"),
    /**
     * Mailbox this agent sends from. Null until Gmail is connected, and set
     * back to null if that mailbox is disconnected — without the FK a deleted
     * account would leave the agent claiming to send from an address that no
     * longer exists.
     */
    emailAccountId: uuid("email_account_id").references(
      () => emailAccounts.id,
      { onDelete: "set null" },
    ),
    lastLaunchAt: timestamp("last_launch_at", { withTimezone: true }),
    nextLaunchAt: timestamp("next_launch_at", { withTimezone: true }),

    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("agents_org_idx").on(t.orgId),
    index("agents_next_launch_idx").on(t.status, t.nextLaunchAt),
  ],
);

/* -------------------------------------------------------------------- lists */

/** User-curated contact lists — the "Lists" tab on Contacts. */
export const lists = pgTable(
  "lists",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Set when a list was created automatically by an agent launch. */
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("lists_org_name_idx").on(t.orgId, t.name)],
);

/* --------------------------------------------------------- company universe */

/**
 * Global, cross-tenant company records deduplicated by domain (or by CUI when
 * no domain is known). Shared on purpose: registry data is public and caching
 * it once keeps us inside free-tier rate limits.
 */
export const companies = pgTable(
  "companies",
  {
    id: id(),
    domain: text("domain"),
    name: text("name").notNull(),
    country: text("country"),
    city: text("city"),
    county: text("county"),
    /**
     * Street address and phone, both of which ANAF has been returning all along.
     *
     * `AnafClient` parses `adresa` and `telefon` into `AnafCompany.address` and
     * `.phone`, and `enrich-registry.ts` has been dropping both on the floor
     * for want of a column to put them in — across 9,455 already-enriched
     * companies. A paid vendor sells phone coverage at 5 credits a company; the
     * free source was already in the payload.
     *
     * Re-run `npm run enrich:registry -- --force` after this lands to backfill
     * them, and measure the result *before* buying phone data from anyone.
     */
    address: text("address"),
    phone: text("phone"),
    website: text("website"),
    linkedinUrl: text("linkedin_url"),
    description: text("description"),
    employeeCount: integer("employee_count"),
    industry: text("industry"),
    /** Detected by our own fingerprinting — replaces BuiltWith/Wappalyzer. */
    techStack: text("tech_stack").array().notNull().default([]),

    // --- Romania-specific registry fields (ANAF / ONRC / BPI) ---
    cui: text("cui"),
    regCom: text("reg_com"),
    /**
     * `SRL`, `SA`, `PFA`, `II`, `IF` — from ONRC's `FORMA_JURIDICA`, and also
     * returned by ANAF and discarded until now.
     *
     * The field that tells a company from a sole trader. Nationally, 328,995
     * trading entities are PFA and 114,171 are II — a quarter of the register —
     * and for those the "administrator" is the whole business rather than a
     * decision-maker inside one. Targeting cannot tell them apart without this.
     */
    legalForm: text("legal_form"),
    caen: text("caen"),
    caenLabel: text("caen_label"),
    vatRegistered: boolean("vat_registered"),
    vatOnCollection: boolean("vat_on_collection"),
    eFacturaRegistered: boolean("e_factura_registered"),
    /** null = no insolvency record found */
    insolvencyStatus: text("insolvency_status"),
    /** The trade register's own status string, as imported from ONRC. */
    onrcStatus: text("onrc_status"),
    registrationDate: date("registration_date"),
    revenueRon: numeric("revenue_ron"),
    revenuePrevRon: numeric("revenue_prev_ron"),
    profitRon: numeric("profit_ron"),
    employeesAnaf: integer("employees_anaf"),
    financialsYear: integer("financials_year"),

    /** Which adapter produced this record: "anaf" | "cuiscan" | "crawler" | ... */
    source: text("source").notNull(),
    lastEnrichedAt: timestamp("last_enriched_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("companies_domain_idx").on(t.domain),
    uniqueIndex("companies_cui_idx").on(t.cui),
    index("companies_caen_idx").on(t.caen),
    index("companies_country_city_idx").on(t.country, t.city),
    // The exact shape of the seeded-slice query the ANAF adapter runs.
    index("companies_country_vat_caen_idx").on(t.country, t.vatRegistered, t.caen),
    /**
     * The index that keeps a sourcing run inside its request.
     *
     * Every ICP with a headcount band produces
     * `… employees_anaf between a and b … order by id limit 25`, and the
     * planner answers `ORDER BY id LIMIT` by walking the primary key and
     * filtering. That is fine until the table is mostly rows the filter throws
     * away: at 351,694 companies only **4,290 have `employees_anaf` at all**,
     * so the scan removed 63,750 rows without finding 25 and the statement
     * timed out at 15s. The wizard's own preview 500'd.
     *
     * Partial on exactly the rows a size filter can ever match, so it holds
     * ~4,290 entries in `id` order instead of 351,694. Measured: **20.9s to
     * 326ms** with a CAEN filter, and 0.7ms without one.
     *
     * `insolvency_status is null` is in the predicate because the adapter
     * always applies it — a distressed company is never a lead — so including
     * it costs nothing and keeps the index smaller.
     */
    index("companies_sized_idx")
      .on(t.id)
      .where(
        sql`${t.employeesAnaf} is not null and ${t.insolvencyStatus} is null`,
      ),
  ],
);

export const people = pgTable(
  "people",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    title: text("title"),
    /** Normalised bucket used by ICP matching: c_level | vp | director | ... */
    seniority: text("seniority"),
    department: text("department"),
    linkedinUrl: text("linkedin_url"),
    location: text("location"),
    source: text("source").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("people_company_idx").on(t.companyId),
    uniqueIndex("people_linkedin_idx").on(t.linkedinUrl),
  ],
);

/**
 * One row per address the waterfall produced, including the ones that failed —
 * that history is what stops us re-spending free-tier credits on a dead lookup.
 */
export const emails = pgTable(
  "emails",
  {
    id: id(),
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    address: text("address").notNull(),
    /** Role addresses (office@, contact@) are the RO-defensible ones. */
    isRoleAddress: boolean("is_role_address").notNull().default(false),
    status: text("status", {
      enum: ["pattern", "found", "verified", "risky", "invalid", "bounced"],
    })
      .notNull()
      .default("pattern"),
    confidence: real("confidence").notNull().default(0),
    /** Which waterfall step produced it: "crawler" | "pattern" | "hunter" | ... */
    provider: text("provider").notNull(),
    mxValid: boolean("mx_valid"),
    smtpChecked: boolean("smtp_checked").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    /**
     * The page this address was published on.
     *
     * Provenance, and it is not optional in spirit for a harvested address. It
     * answers "where did you get this" without anyone having to reconstruct a
     * crawl, which is what a subject access request asks and what distinguishes
     * an address a company published from one we generated. Null for a
     * pattern-derived address, which by definition came from no page.
     */
    sourceUrl: text("source_url"),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("emails_person_address_idx").on(t.personId, t.address),
    index("emails_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------ scan state */

/**
 * What the last scan saw at a company, so the next one can diff.
 *
 * Four signal sources work by comparison rather than observation — tech-stack
 * added/removed, pricing-page changed, hiring surge, and first-time VAT
 * registration. None of them can ever fire without a record of the previous
 * scan, and `signals` cannot supply it: signals record what *changed*, and a
 * diff needs what did **not**. "The stack is still WordPress and Stripe"
 * produces no signal and is exactly the state the next comparison requires.
 *
 * A table rather than a jsonb column on `companies`, for two reasons. The
 * scheduler asks "which companies are due a scan" on every run and wants an
 * index for it, not a jsonb path expression over a table heading for millions
 * of rows. And `companies` is the hot read path, concurrently written by both
 * importers; scan bookkeeping has no business contending with them.
 *
 * Shared reference data like `companies` — public facts about a public website,
 * no `orgId`, service-role writes only.
 */
export const companyScans = pgTable(
  "company_scans",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),

    /** Detected by `fingerprintTech`; the diff input for tech_stack_added/removed. */
    techStack: text("tech_stack").array().notNull().default([]),
    /** Which page the hash belongs to, so the next scan compares the same one. */
    pricingPageUrl: text("pricing_page_url"),
    pricingPageHash: text("pricing_page_hash"),
    careersPageUrl: text("careers_page_url"),
    careersJobTitles: text("careers_job_titles").array().notNull().default([]),

    /**
     * Carried from the `companies` row at scan time.
     *
     * Copied rather than read live because the diff must compare against what
     * the previous *scan* saw. Reading `companies` at scan time compares a value
     * with itself and never fires.
     */
    revenueRon: numeric("revenue_ron"),
    vatRegistered: boolean("vat_registered"),

    /**
     * The company's email convention, and how well we know it.
     *
     * A fact about the *company*, not about any one person, which is why it
     * lives on the scan row rather than beside an address. Once `first.last` is
     * confirmed here, every administrator ONRC gives us at this domain has a
     * derivable address at high confidence — that is the whole mechanism by
     * which a named contact becomes reachable without a data vendor.
     *
     * `emailPatternSource` separates the two ways it can be known: `inferred`
     * from an address actually published at this domain, or `prior` from the
     * measured distribution across every domain we have inferred. The
     * difference is large and must not be flattened into the confidence alone.
     */
    emailPattern: text("email_pattern"),
    emailPatternConfidence: real("email_pattern_confidence"),
    /**
     * How the convention was arrived at. These are different kinds of evidence
     * and must not be averaged together:
     *
     *   `paired`   — an address matched a person we hold from the register.
     *                Confirmation of both the person and the convention.
     *   `shape`    — an address read as a name by the lexicon, owner unknown.
     *                Legible, not confirmed. The common case, by far.
     *   `prior`    — no evidence at this domain; the measured distribution.
     *   `inferred` — legacy, written before the two were told apart. Means
     *                "paired or shape, we did not record which".
     */
    emailPatternSource: text("email_pattern_source", {
      enum: ["paired", "shape", "prior", "inferred"],
    }),
    /** Confirmed name/address pairs behind the pattern. One is weak, three is not. */
    emailPatternSamples: integer("email_pattern_samples").notNull().default(0),
    /**
     * When the harvester last looked, whether or not it found anything.
     *
     * Distinct from `email_pattern` being set, and the distinction is the same
     * one `company_scans` exists for in the first place: a *found* pattern
     * records what fired, and resuming a run needs to know what did **not**.
     * Keying the skip list on `email_pattern` meant a resumed harvest re-crawled
     * every domain that had already answered "nothing here" — measured at 518
     * re-crawls producing zero new patterns before this column existed.
     *
     * Also distinct from `scanned_at`, which `scan-signals.ts` writes for its
     * own reasons; a company scanned for signals has not necessarily been
     * harvested for addresses.
     */
    emailPatternCheckedAt: timestamp("email_pattern_checked_at", {
      withTimezone: true,
    }),

    /**
     * Where the domain's mail actually lands, from the MX lookup.
     *
     * Kept because deliverability behaviour is provider-specific: a Google
     * Workspace tenant rejects unknown recipients, while a shared cPanel host
     * usually accepts everything. `catchAll` is that second case, and it is the
     * reason a verified-looking answer can still be worthless — an address at a
     * catch-all domain is never promoted past `risky`.
     */
    mxProvider: text("mx_provider"),
    catchAll: boolean("catch_all"),

    /** Which ICP keywords were found, and on which page. */
    keywordHits: jsonb("keyword_hits"),
    /** Per-source ok/skipped/error, so a quietly failing source is visible. */
    sourceResults: jsonb("source_results"),

    scanStatus: text("scan_status", { enum: ["ok", "unreachable", "error"] })
      .notNull()
      .default("ok"),
    /** Backoff input: a site down four scans running is not worth a fifth. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    scannedAt: timestamp("scanned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("company_scans_scanned_idx").on(t.scannedAt)],
);

/* ----------------------------------------------------------------- signals */

/**
 * Buying-intent events. `evidenceUrl` is mandatory in spirit: every signal we
 * show must be clickable back to its public source. That auditability is our
 * stated differentiator over Gojiberry.
 */
export const signals = pgTable(
  "signals",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /** SignalSource key: "hiring_surge" | "funding_news" | "anaf_growth" | ... */
    type: text("type").notNull(),
    title: text("title").notNull(),
    payload: jsonb("payload"),
    evidenceUrl: text("evidence_url"),
    /** 0..1, before recency decay is applied at scoring time. */
    strength: real("strength").notNull().default(0.5),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Natural key for the source, so re-scans don't duplicate. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("signals_dedupe_idx").on(t.dedupeKey),
    index("signals_company_detected_idx").on(t.companyId, t.detectedAt),
    index("signals_type_idx").on(t.type),
  ],
);

/* ------------------------------------------------------------------- leads */

export const leads = pgTable(
  "leads",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    emailId: uuid("email_id").references(() => emails.id, {
      onDelete: "set null",
    }),

    score: real("score").notNull().default(0),
    /** { icpFit, signalStrength, contactability, penalties } — rendered in UI. */
    scoreBreakdown: jsonb("score_breakdown"),

    status: text("status", {
      enum: [
        "new",
        "approved",
        "queued",
        "sent",
        "replied",
        "bounced",
        "rejected",
      ],
    })
      .notNull()
      .default("new"),
    /** Cached from company.country so compliance rules resolve without a join. */
    complianceRegion: text("compliance_region"),
    rejectedReason: text("rejected_reason"),

    /**
     * The user's verdict on this lead, from the FIT column. Explicit training
     * data for later scoring work — and, unlike an implicit signal such as
     * "did they send", it distinguishes "wrong" from "not yet".
     */
    fitFeedback: text("fit_feedback", { enum: ["good", "unsure", "bad"] }),
    /** Which sourcing path produced this lead. Groups the Insights grid. */
    sourceLabel: text("source_label"),
    /** The keyword or CAEN code the launch ran on, shown under the chip. */
    sourceQuery: text("source_query"),
    /**
     * When the email waterfall last ran for this lead.
     *
     * Distinguishes "we looked and found nothing" from "we have not looked",
     * which `email_id IS NULL` cannot. Without it every bulk re-run would spend
     * the whole free tier re-asking questions that already came back empty —
     * and a miss is the common case, not the exception.
     */
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("leads_agent_person_idx").on(t.agentId, t.personId),
    index("leads_org_status_score_idx").on(t.orgId, t.status, t.score),
    index("leads_agent_created_idx").on(t.agentId, t.createdAt),
  ],
);

/** Membership is by lead, not by person: a list is scoped to one workspace. */
export const listMembers = pgTable(
  "list_members",
  {
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.leadId] }),
    index("list_members_lead_idx").on(t.leadId),
  ],
);

/* ---------------------------------------------------------------- outreach */

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    status: text("status", { enum: ["draft", "active", "paused", "done"] })
      .notNull()
      .default("draft"),
    /**
     * Off by default. When false every message stops at the user's Gmail
     * Drafts and requires an explicit approve-and-send.
     */
    autoSend: boolean("auto_send").notNull().default(false),
    /** Gmail address the user chose to send from. */
    senderEmail: text("sender_email"),
    dailySendLimit: integer("daily_send_limit").notNull().default(30),
    /** Set once the user has acknowledged the RO opt-in warning (plan §9). */
    complianceAckAt: timestamp("compliance_ack_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("campaigns_org_idx").on(t.orgId)],
);

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: id(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    channel: text("channel", { enum: ["email", "linkedin"] })
      .notNull()
      .default("email"),
    delayDays: integer("delay_days").notNull().default(0),
    /** Prompt guidance for Claude, not a mail-merge template. */
    instruction: text("instruction"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sequence_step_idx").on(t.campaignId, t.stepIndex)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    sequenceStepId: uuid("sequence_step_id").references(() => sequenceSteps.id, {
      onDelete: "set null",
    }),

    channel: text("channel", { enum: ["email", "linkedin"] })
      .notNull()
      .default("email"),
    language: text("language").notNull().default("en"),
    subject: text("subject"),
    body: text("body").notNull(),
    /** The signal the copy was built around, for "why this lead" in the UI. */
    signalId: uuid("signal_id").references(() => signals.id, {
      onDelete: "set null",
    }),

    state: text("state", {
      enum: ["drafted", "in_gmail_drafts", "approved", "sent", "failed", "skipped"],
    })
      .notNull()
      .default("drafted"),
    gmailDraftId: text("gmail_draft_id"),
    gmailMessageId: text("gmail_message_id"),
    gmailThreadId: text("gmail_thread_id"),
    failureReason: text("failure_reason"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("messages_org_state_idx").on(t.orgId, t.state),
    index("messages_lead_idx").on(t.leadId),
    index("messages_scheduled_idx").on(t.scheduledFor),
  ],
);

/* ------------------------------------------------------- channels & limits */

/**
 * Connected Gmail accounts. Only `gmail.send` + `gmail.compose` are requested —
 * both sensitive, neither restricted, so no CASA audit is required (plan §8).
 *
 * Refresh tokens are encrypted at rest with `ENCRYPTION_KEY`; this table is
 * never exposed through PostgREST (RLS denies all, service-role only).
 */
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    provider: text("provider", { enum: ["gmail"] }).notNull().default("gmail"),
    address: text("address").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    dailySentCount: integer("daily_sent_count").notNull().default(0),
    dailyCountResetAt: date("daily_count_reset_at"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("email_accounts_org_address_idx").on(t.orgId, t.address)],
);

/**
 * Credit ledger for the enrichment waterfall. The EmailFinder chain reads this
 * before calling a provider so an exhausted free tier is skipped rather than
 * hammered into a 429.
 */
export const providerUsage = pgTable(
  "provider_usage",
  {
    id: id(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** YYYY-MM — free tiers reset monthly. */
    periodMonth: text("period_month").notNull(),
    creditsUsed: integer("credits_used").notNull().default(0),
    creditsLimit: integer("credits_limit"),
    lastCallAt: timestamp("last_call_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("provider_usage_idx").on(t.orgId, t.provider, t.periodMonth),
  ],
);

/** Org-wide do-not-contact. Checked before every single send, no exceptions. */
export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Either a full address or a bare domain. */
    value: text("value").notNull(),
    kind: text("kind", { enum: ["address", "domain"] })
      .notNull()
      .default("address"),
    reason: text("reason", {
      enum: ["unsubscribed", "bounced", "complaint", "manual"],
    })
      .notNull()
      .default("manual"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("suppressions_org_value_idx").on(t.orgId, t.value)],
);

/**
 * Append-only audit of agent runs. Read by two surfaces, which is why it
 * carries display strings and not only stats: the per-agent Activity Feed
 * ("21 new leads found") and the Insights grid, which groups launches by agent,
 * day and source. Deriving those strings at read time from `stats` would put
 * the copy for every run kind in the renderer instead of next to the code that
 * produced the run.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    status: text("status", { enum: ["running", "ok", "failed"] })
      .notNull()
      .default("running"),

    /** Feed headline, e.g. "21 new leads found" or "Email sent". */
    title: text("title"),
    /** Feed second line: the person, the keyword, the agent name. */
    subtitle: text("subtitle"),
    /** keyword | lookalike | autopilot | signal — groups the Insights grid. */
    sourceLabel: text("source_label"),
    /** The keyword or code this launch ran on. */
    sourceQuery: text("source_query"),
    leadsFound: integer("leads_found").notNull().default(0),

    stats: jsonb("stats"),
    error: text("error"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("job_runs_org_kind_idx").on(t.orgId, t.kind),
    index("job_runs_agent_started_idx").on(t.agentId, t.startedAt),
  ],
);
