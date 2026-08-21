import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchRoleEmails } from "@/lib/crawl/fetch-site";
import { getEnv } from "@/lib/env";
import { rescoreWithEmail, type ScoreBreakdown } from "@/lib/signals/scoring";
import { allPeopleProviders } from "@/lib/sources/people/registry";
import { embedded } from "@/lib/data/rows";
import { optionalDate, optionalString, requireString } from "@/lib/supabase/row";
import { CreditLedger } from "./ledger";
import { MxChecker } from "./mx";
import { FREE_TIER_LIMITS, SupabaseUsageStore } from "./supabase-ledger";
import {
  EmailWaterfall,
  type ResolvedEmail,
  type WaterfallAttempt,
} from "./waterfall";

/**
 * Enrichment: the step that turns a scored lead into a contactable one.
 *
 * `EmailWaterfall` was written, tested and then left without a caller. This is
 * that caller. It does three things the waterfall deliberately does not:
 *
 *   - supplies `knownRoleEmails`, by crawling the prospect's own site. Without
 *     a producer, the waterfall's cheapest and most reliable step runs empty
 *     and every lookup falls through to a vendor credit.
 *   - persists the result, misses included, so a dead lookup is never paid for
 *     twice.
 *   - re-scores. Contactability is 20% of a lead's score and is zero without an
 *     address, so a lead that stays at its pre-enrichment score has silently
 *     not been enriched.
 *
 * The orchestration is separated from the writes on purpose: `enrichLead` takes
 * its IO as dependencies and can be tested without a database or a network,
 * while `saveEnrichment` is the thin part that talks to PostgREST.
 */

/**
 * Where the waterfall stops.
 *
 * 0.55 is exactly the confidence of a crawled role address, so finding an
 * `office@` ends the chain before any vendor is asked. That is the intended
 * trade: a role address reaches the company rather than the person and scores
 * lower for it, but it is free, it is what a Romanian company publishes as its
 * own contact route, and Hunter's free tier is 25 searches a month. Spending
 * one of those to improve a lead we can already reach is the wrong use of a
 * scarce resource.
 */
const ROLE_ADDRESS_IS_ENOUGH = 0.55;

export type EnrichableLead = {
  id: string;
  personId: string | null;
  companyId: string | null;
  fullName: string;
  companyName: string;
  /** Null for ~99% of registry companies — see the landmine in docs/STATUS.md. */
  domain: string | null;
  breakdown: ScoreBreakdown;
  /** When the waterfall last ran. Null means never. */
  enrichedAt: Date | null;
  /**
   * Role addresses already known for this company, from a previous harvest.
   *
   * `emails` is shared reference data keyed by company as well as by person, so
   * once one lead's crawl has found `office@firma.ro`, every later lead at that
   * company should read it rather than fetch the same page again. Empty or
   * absent means "not harvested yet", and the crawl runs.
   */
  knownRoleEmails?: string[];
};

export type EnrichmentOutcome = {
  leadId: string;
  email: ResolvedEmail | null;
  attempts: WaterfallAttempt[];
  /** Runners-up, kept for a retry after a bounce. Never auto-sent to. */
  alternatives: ResolvedEmail[];
  /** Set when the waterfall was not run at all, and why. */
  skipped?: "no_domain" | "already_tried";
  scoreBefore: number;
  scoreAfter: number;
  breakdown: ScoreBreakdown;
};

export type EnrichLeadDeps = {
  waterfall: EmailWaterfall;
  /** Injected so tests need no network; defaults to the real crawler. */
  roleEmails?: (domain: string) => Promise<string[]>;
};

export type EnrichLeadOptions = {
  /** Re-run even if this lead was already tried. */
  force?: boolean;
  targetConfidence?: number;
};

/**
 * Resolve an address for one lead.
 *
 * Never throws for the ordinary failures — no domain, an unreachable site, a
 * domain that accepts no mail. Those are the common cases when working from a
 * trade register, and a bulk run that stops on the first of them would stop
 * immediately. They come back as an outcome with a null email and an attempt
 * trail explaining why.
 */
export async function enrichLead(
  deps: EnrichLeadDeps,
  lead: EnrichableLead,
  options: EnrichLeadOptions = {},
): Promise<EnrichmentOutcome> {
  const unchanged = (skipped: EnrichmentOutcome["skipped"]): EnrichmentOutcome => ({
    leadId: lead.id,
    email: null,
    attempts: [],
    alternatives: [],
    skipped,
    scoreBefore: lead.breakdown.total,
    scoreAfter: lead.breakdown.total,
    breakdown: lead.breakdown,
  });

  // A previous run already answered this. Re-asking costs a crawl at best and
  // a vendor credit at worst, for a question whose answer has not changed.
  if (lead.enrichedAt && !options.force) return unchanged("already_tried");

  // No domain, no site to crawl and no domain to infer a pattern for. This is
  // the majority case and it is a supply problem, not a failure — see step 5b.
  if (!lead.domain) return unchanged("no_domain");

  const crawl = deps.roleEmails ?? fetchRoleEmails;
  // A site that is down, JavaScript-only or blocking us yields nothing; the
  // waterfall's later steps are still worth running.
  const knownRoleEmails = lead.knownRoleEmails?.length
    ? lead.knownRoleEmails
    : await crawl(lead.domain).catch(() => []);

  const result = await deps.waterfall.resolve({
    fullName: lead.fullName,
    domain: lead.domain,
    companyName: lead.companyName,
    knownRoleEmails,
    targetConfidence: options.targetConfidence ?? ROLE_ADDRESS_IS_ENOUGH,
  });

  const breakdown = rescoreWithEmail(
    lead.breakdown,
    result.email
      ? {
          status: result.email.status,
          confidence: result.email.confidence,
          isRoleAddress: result.email.isRoleAddress,
        }
      : undefined,
  );

  return {
    leadId: lead.id,
    email: result.email,
    attempts: result.attempts,
    alternatives: result.alternatives,
    scoreBefore: lead.breakdown.total,
    scoreAfter: breakdown.total,
    breakdown,
  };
}

/**
 * The waterfall, wired to the real ledger and the real providers.
 *
 * `admin` must be the service-role client: `provider_usage` denies all user
 * access by design, so a request-scoped client reads nothing there and every
 * metered provider would look unmetered — which is the exact failure the ledger
 * exists to prevent.
 */
export function buildWaterfall(
  admin: SupabaseClient,
  orgId: string,
  bindings?: Record<string, unknown>,
): EmailWaterfall {
  const env = getEnv(bindings);

  return new EmailWaterfall({
    ledger: new CreditLedger(
      new SupabaseUsageStore(admin, FREE_TIER_LIMITS),
      orgId,
    ),
    mx: new MxChecker(),
    providers: allPeopleProviders({
      HUNTER_API_KEY: env.HUNTER_API_KEY,
      PROSPEO_API_KEY: env.PROSPEO_API_KEY,
      PDL_API_KEY: env.PDL_API_KEY,
      APIFY_TOKEN: env.APIFY_TOKEN,
      APIFY_PEOPLE_ACTOR: env.APIFY_PEOPLE_ACTOR,
    }),
    // No verifier: Cloudflare Workers blocks outbound port 25, so SMTP RCPT
    // probing is impossible in-process. See step 5d in docs/STATUS.md.
  });
}

/** The joined shape both the route and the bulk script select. Keep on one line. */
export const ENRICHABLE_LEAD_COLUMNS =
  "id, person_id, company_id, score_breakdown, enriched_at, people(full_name), companies(name, domain)";

/**
 * Map the joined row to what enrichment needs.
 *
 * The generated `Database` type is still a placeholder, so every selected
 * column arrives as `unknown` and is narrowed at runtime rather than cast —
 * same reason `src/lib/supabase/row.ts` exists.
 */
export function enrichableLeadFrom(row: Record<string, unknown>): EnrichableLead {
  const person = embedded(row.people);
  const company = embedded(row.companies);
  const breakdown = (row.score_breakdown ?? null) as ScoreBreakdown | null;

  return {
    id: requireString(row.id, "id"),
    personId: optionalString(row.person_id) ?? null,
    companyId: optionalString(row.company_id) ?? null,
    fullName: optionalString(person?.full_name) ?? "",
    companyName: optionalString(company?.name) ?? "",
    domain: optionalString(company?.domain) ?? null,
    // A lead with no stored breakdown would otherwise re-score from nothing and
    // come out lower than it was; an empty shell keeps the arithmetic honest.
    breakdown: breakdown ?? emptyBreakdown(),
    enrichedAt: optionalDate(row.enriched_at) ?? null,
  };
}

function emptyBreakdown(): ScoreBreakdown {
  return {
    total: 0,
    icpFit: { score: 0, weight: 0.45, reasons: [] },
    signals: { score: 0, weight: 0.35, reasons: [] },
    contactability: { score: 0, weight: 0.2, reasons: [] },
    penalties: { total: 0, reasons: [] },
  };
}

export type SaveEnrichmentResult = {
  emailId: string | null;
  error?: string;
};

/**
 * Persist an outcome.
 *
 * Two clients, because the two tables sit on opposite sides of the tenancy
 * boundary. `emails` is shared reference data with no `org_id` at all — like
 * `companies` and `people`, `authenticated` may read it and only the service
 * role may write, so an insert through a request-scoped client silently
 * affects nothing. `leads` is a tenant row, so it is written through the
 * caller's own client and RLS decides whether they may.
 *
 * `enriched_at` is stamped even when nothing was found. That is the point of
 * recording misses: without it, `email_id IS NULL` cannot tell a lead we looked
 * at from one we have not reached yet, and every bulk re-run re-spends the
 * budget on the same empty answers.
 */
export async function saveEnrichment(
  clients: { admin: SupabaseClient; scoped: SupabaseClient },
  lead: EnrichableLead,
  outcome: EnrichmentOutcome,
  now = new Date(),
): Promise<SaveEnrichmentResult> {
  if (outcome.skipped) return { emailId: null };

  let emailId: string | null = null;

  if (outcome.email) {
    const saved = await upsertEmail(clients.admin, lead, outcome.email);
    if (saved.error) return { emailId: null, error: saved.error };
    emailId = saved.emailId;
  }

  const { error } = await clients.scoped
    .from("leads")
    .update({
      // Only ever set, never cleared: a re-run that finds nothing must not
      // detach an address an earlier run did find.
      ...(emailId ? { email_id: emailId } : {}),
      score: outcome.breakdown.total,
      score_breakdown: outcome.breakdown,
      enriched_at: now.toISOString(),
    })
    .eq("id", lead.id);

  if (error) return { emailId, error: `Updating the lead failed: ${error.message}` };
  return { emailId };
}

/**
 * Persist a role address against the company rather than a person.
 *
 * `office@firma.ro` belongs to the company, not to whichever administrator
 * happened to be the first lead sourced there. Storing it that way means the
 * page is fetched once and every future lead at that company starts with an
 * address already in hand — which matters because harvesting is the free step
 * and the site does not change between leads.
 */
export async function saveCompanyRoleEmail(
  admin: SupabaseClient,
  companyId: string,
  address: string,
): Promise<SaveEnrichmentResult> {
  return upsertEmail(
    admin,
    { personId: null, companyId },
    {
      address,
      status: "found",
      confidence: 0.55,
      provider: "crawler",
      isRoleAddress: true,
      mxValid: undefined,
    },
  );
}

/**
 * An address read off a company's own site, with the page that published it.
 *
 * Shares `upsertEmail` with every other writer rather than issuing its own
 * insert, because the uniqueness rule here is subtle enough to get wrong twice:
 * `emails_person_address_idx` is on `(person_id, address)`, and Postgres treats
 * NULLs as distinct — so a role address, which has no person, does not conflict
 * with itself and a plain upsert would duplicate it on every re-run.
 */
export async function saveHarvestedEmail(
  admin: SupabaseClient,
  target: { personId: string | null; companyId: string },
  email: ResolvedEmail,
  sourceUrl: string,
): Promise<SaveEnrichmentResult> {
  return upsertEmail(admin, target, email, sourceUrl);
}

/**
 * Role addresses already harvested for these companies.
 *
 * Read in one query rather than per lead: a bulk run touches hundreds of leads
 * and a lookup each is how a script acquires an N+1 against a hosted database.
 */
export async function knownRoleEmailsFor(
  db: SupabaseClient,
  companyIds: string[],
): Promise<Map<string, string[]>> {
  const byCompany = new Map<string, string[]>();
  if (companyIds.length === 0) return byCompany;

  const { data, error } = await db
    .from("emails")
    .select("company_id, address, is_role_address")
    .in("company_id", companyIds)
    .eq("is_role_address", true);

  if (error) {
    console.error("Reading known role addresses failed:", error.message);
    return byCompany;
  }

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const companyId = optionalString(row.company_id);
    const address = optionalString(row.address);
    if (!companyId || !address) continue;
    byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), address]);
  }
  return byCompany;
}

/**
 * Insert the address, or return the row that already holds it.
 *
 * `emails_person_address_idx` is unique on (person_id, address), so the same
 * address for the same person is one row however many times enrichment runs.
 * Postgres treats NULLs as distinct in a unique index, though, so a lead with
 * no person would insert a duplicate on every pass — hence the explicit lookup
 * rather than a bare upsert.
 */
async function upsertEmail(
  admin: SupabaseClient,
  target: { personId: string | null; companyId: string | null },
  email: ResolvedEmail,
  /** The page it was published on, for a harvested address. */
  sourceUrl?: string,
): Promise<SaveEnrichmentResult> {
  const address = email.address.toLowerCase();

  let existing = admin
    .from("emails")
    .select("id")
    .eq("address", address)
    .limit(1);
  existing = target.personId
    ? existing.eq("person_id", target.personId)
    : existing.is("person_id", null).eq("company_id", target.companyId ?? "");

  const found = await existing.maybeSingle();
  if (found.error) {
    return { emailId: null, error: `Reading emails failed: ${found.error.message}` };
  }

  const row = {
    person_id: target.personId,
    company_id: target.companyId,
    address,
    is_role_address: email.isRoleAddress,
    status: email.status,
    confidence: email.confidence,
    provider: email.provider,
    mx_valid: email.mxValid ?? null,
    // Only a mailbox check may set this, and there is no verifier yet.
    smtp_checked: false,
    /*
     * Preserved, not overwritten, when absent. A later pass that re-resolves an
     * address without crawling must not erase the record of where the earlier
     * one found it — provenance is the thing we would most regret losing.
     */
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
  };

  const written = found.data
    ? await admin
        .from("emails")
        .update(row)
        .eq("id", (found.data as { id: string }).id)
        .select("id")
        .single()
    : await admin.from("emails").insert(row).select("id").single();

  if (written.error) {
    return { emailId: null, error: `Writing the email failed: ${written.error.message}` };
  }
  return { emailId: (written.data as { id: string }).id };
}
