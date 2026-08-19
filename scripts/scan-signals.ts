/**
 * Scans companies for buying signals and writes what it finds.
 *
 *   npm run scan:signals -- --dry-run --limit 20
 *   npm run scan:signals -- --tier a --limit 500
 *   npm run scan:signals -- --no-web            # registry signals only, no HTTP
 *   npm run scan:signals -- --live-anaf         # re-ask ANAF instead of the row
 *
 * This is the caller `SignalScanner` never had. Until it ran, `scoreSignals`
 * returned a constant zero for **35% of every lead's score**, which is why every
 * lead sat at exactly 45 and, after email enrichment, exactly 54.
 *
 * Three tiers, because scanning 17,156 companies over live HTTP is not a thing
 * you do on a whim:
 *
 *   a  companies somebody already has a lead for   — the ones that matter today
 *   b  companies with a website                    — everything web sources can read
 *   c  everything else                             — registry signals only, no HTTP
 *
 * Service role throughout: `signals` and `company_scans` are shared reference
 * data with no insert policy for `authenticated`, so a session-scoped client
 * would write nothing and say so with no error.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SCAN_CONCURRENCY,
  emptyTargeting,
  scanRun,
  type ScanCandidate,
  type ScanRunDeps,
  type ScanTargeting,
} from "../src/lib/pipeline/signal-scan";
import type { RegistryCompany } from "../src/lib/pipeline/source-run";
import { upsertSignals } from "../src/lib/signals/repository";
import { selectSignalSources } from "../src/lib/signals/scanner";
import { AnafClient } from "../src/lib/sources/anaf/client";
import { requireEnv } from "./load-env";

const PAGE = 1000;
const ID_CHUNK = 100;

type Tier = "a" | "b" | "c";

type Options = {
  tier: Tier;
  limit?: number;
  dryRun: boolean;
  web: boolean;
  liveAnaf: boolean;
  agentId?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { tier: "a", dryRun: false, web: true, liveAnaf: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--tier": {
        const value = next();
        if (value !== "a" && value !== "b" && value !== "c") {
          throw new Error(`--tier must be a, b or c (got ${value})`);
        }
        options.tier = value;
        break;
      }
      case "--limit":
        options.limit = Number(next());
        break;
      case "--agent":
        options.agentId = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-web":
        options.web = false;
        break;
      case "--live-anaf":
        options.liveAnaf = true;
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** The columns the scan needs. One literal — see the PostgREST landmine in STATUS. */
const COMPANY_COLUMNS =
  "id, name, domain, website, country, county, city, cui, reg_com, caen, caen_label, vat_registered, insolvency_status, registration_date, revenue_ron, revenue_prev_ron, employees_anaf, financials_year";

function toCompany(row: Record<string, unknown>): RegistryCompany {
  const cui = row.cui as string | null;
  const number = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));
  return {
    id: String(row.id),
    dedupeKey: cui ? `cui:${cui}` : String(row.id),
    name: String(row.name),
    domain: (row.domain as string) ?? undefined,
    website: (row.website as string) ?? undefined,
    country: (row.country as string) ?? undefined,
    county: (row.county as string) ?? undefined,
    city: (row.city as string) ?? undefined,
    cui: cui ?? undefined,
    regCom: (row.reg_com as string) ?? undefined,
    caen: (row.caen as string) ?? undefined,
    caenLabel: (row.caen_label as string) ?? undefined,
    vatRegistered: typeof row.vat_registered === "boolean" ? row.vat_registered : undefined,
    insolvencyStatus: (row.insolvency_status as string) ?? null,
    registrationDate: (row.registration_date as string) ?? undefined,
    revenueRon: number(row.revenue_ron),
    revenuePrevRon: number(row.revenue_prev_ron),
    employeesAnaf: number(row.employees_anaf),
    financialsYear: number(row.financials_year),
    source: "onrc",
  };
}

/** Company ids that already have a lead — tier A. */
async function leadCompanyIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("leads")
      .select("company_id")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`Could not read leads: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as { company_id: string }[];
    for (const row of rows) ids.add(row.company_id);
    if (rows.length < PAGE) break;
  }
  return ids;
}

async function loadCompanies(options: Options): Promise<RegistryCompany[]> {
  if (options.tier === "a") {
    const ids = [...(await leadCompanyIds())];
    const companies: RegistryCompany[] = [];
    // Chunked: a few hundred UUIDs in one in() is a URL PostgREST refuses.
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await db
        .from("companies")
        .select(COMPANY_COLUMNS)
        .in("id", ids.slice(i, i + ID_CHUNK));
      if (error) {
        console.error(`Could not read companies: ${error.message}`);
        process.exit(1);
      }
      companies.push(...(data ?? []).map((row) => toCompany(row as Record<string, unknown>)));
    }

    /*
     * Companies we can actually read, first.
     *
     * Four of the seven sources need a website. Taking lead companies in
     * whatever order they arrive means a bounded run can spend its whole budget
     * on companies where every web source is skipped — which is exactly what the
     * first run did. A company we can read is worth scanning before one we
     * cannot.
     */
    companies.sort((a, b) => Number(Boolean(b.domain)) - Number(Boolean(a.domain)));
    return options.limit ? companies.slice(0, options.limit) : companies;
  }

  const companies: RegistryCompany[] = [];
  for (let from = 0; ; from += PAGE) {
    const wanted = options.limit ? Math.min(PAGE, options.limit - companies.length) : PAGE;
    if (wanted <= 0) break;

    let query = db
      .from("companies")
      .select(COMPANY_COLUMNS)
      .order("id", { ascending: true })
      .range(from, from + wanted - 1);
    query = options.tier === "b"
      ? query.not("domain", "is", null)
      : query.is("domain", null);

    const { data, error } = await query;
    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    companies.push(...rows.map(toCompany));
    if (rows.length < wanted) break;
  }
  return companies;
}

/** Previous scan state, keyed by company. */
async function loadPrevious(
  companyIds: string[],
): Promise<Map<string, { previous: ScanCandidate["previous"]; failures: number }>> {
  const byCompany = new Map<string, { previous: ScanCandidate["previous"]; failures: number }>();

  for (let i = 0; i < companyIds.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from("company_scans")
      .select(
        "company_id, tech_stack, pricing_page_hash, careers_job_titles, revenue_ron, vat_registered, consecutive_failures",
      )
      .in("company_id", companyIds.slice(i, i + ID_CHUNK));
    if (error) {
      console.error(`Could not read company_scans: ${error.message}`);
      process.exit(1);
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      byCompany.set(String(row.company_id), {
        previous: {
          techStack: (row.tech_stack as string[]) ?? undefined,
          pricingPageHash: (row.pricing_page_hash as string) ?? undefined,
          careersJobTitles: (row.careers_job_titles as string[]) ?? undefined,
          revenueRon: row.revenue_ron === null ? undefined : Number(row.revenue_ron),
          vatRegistered:
            typeof row.vat_registered === "boolean" ? row.vat_registered : undefined,
        },
        failures: Number(row.consecutive_failures ?? 0),
      });
    }
  }
  return byCompany;
}

/** The agent's targeting, so hiring and keyword sources know what to look for. */
async function loadTargeting(agentId?: string): Promise<ScanTargeting> {
  const query = db
    .from("agents")
    .select("id, target_titles, keywords, enabled_signals")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1);

  const { data, error } = agentId
    ? await db
        .from("agents")
        .select("id, target_titles, keywords, enabled_signals")
        .eq("id", agentId)
        .maybeSingle()
    : await query.maybeSingle();

  if (error) {
    console.error(`Could not read the agent: ${error.message}`);
    process.exit(1);
  }
  if (!data) return emptyTargeting();

  const row = data as Record<string, unknown>;
  return {
    ...emptyTargeting(),
    targetTitles: (row.target_titles as string[]) ?? [],
    keywords: (row.keywords as string[]) ?? [],
    enabledSignals: (row.enabled_signals as string[]) ?? [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targeting = await loadTargeting(options.agentId);
  const companies = await loadCompanies(options);

  const previous = await loadPrevious(companies.map((c) => c.id));
  const firstScans = companies.filter((c) => !previous.has(c.id)).length;

  console.log(
    `tier ${options.tier}: ${companies.length} companies ` +
      `(${companies.filter((c) => c.domain).length} with a website)\n` +
      `${firstScans} have never been scanned — their diff-based signals cannot ` +
      `fire yet, by design\n` +
      `targeting: ${targeting.targetTitles.length} titles, ` +
      `${targeting.keywords.length} keywords, ` +
      `${targeting.enabledSignals.length || "all"} sources\n`,
  );
  if (companies.length === 0) return;

  if (options.dryRun) {
    for (const company of companies.slice(0, 15)) {
      console.log(`  ${(company.domain ?? "—").padEnd(30)} ${company.name.slice(0, 40)}`);
    }
    console.log("\nDry run — nothing was fetched and nothing was written.");
    return;
  }

  const anaf = options.liveAnaf ? new AnafClient() : undefined;
  const candidates: ScanCandidate[] = companies.map((company) => {
    const state = previous.get(company.id);
    return {
      company,
      previous: state?.previous,
      consecutiveFailures: state?.failures ?? 0,
      // Empty until a person-level provider exists — see person-engagement.ts.
      people: [],
    };
  });

  let index = 0;
  const deps: ScanRunDeps = {
    async findCandidates(limit) {
      const page = candidates.slice(index, index + limit);
      index += page.length;
      return { candidates: page, cursor: undefined, notes: [] };
    },
    sources: (t) => selectSignalSources({ enabled: t.enabledSignals, anaf }),
  };

  const byType = new Map<string, number>();
  const bySource = new Map<string, { ok: number; skipped: number; error: number }>();
  let scanned = 0;
  let written = 0;
  let unreachable = 0;
  let withSignals = 0;

  while (index < candidates.length) {
    const page = await scanRun(deps, {
      targeting,
      limit: DEFAULT_SCAN_CONCURRENCY * 4,
      concurrency: DEFAULT_SCAN_CONCURRENCY,
      web: options.web,
    });

    for (const result of page.results) {
      scanned += 1;
      if (result.status === "unreachable") unreachable += 1;
      if (result.signals.length > 0) withSignals += 1;
      for (const signal of result.signals) {
        byType.set(signal.type, (byType.get(signal.type) ?? 0) + 1);
      }
      for (const source of result.sourceResults) {
        const entry = bySource.get(source.source) ?? { ok: 0, skipped: 0, error: 0 };
        entry[source.status] += 1;
        bySource.set(source.source, entry);
      }

      written += await persist(db, result);
    }

    process.stdout.write(
      `\r  scanned ${scanned}/${candidates.length}, ${withSignals} with a signal`,
    );
  }

  console.log(
    `\n\n${scanned} companies scanned, ${unreachable} unreachable\n` +
      `${withSignals} produced at least one signal, ${written} signal rows written\n`,
  );

  if (byType.size > 0) {
    console.log("signals by type:");
    for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(24)} ${count}`);
    }
  }

  console.log("\nper source (ok / skipped / error):");
  for (const [source, counts] of bySource) {
    console.log(
      `  ${source.padEnd(16)} ${String(counts.ok).padStart(5)} ${String(counts.skipped).padStart(8)} ${String(counts.error).padStart(6)}`,
    );
  }
  console.log(
    "\nMost skips on a first run are diff-based sources with nothing to diff\n" +
      "against yet. Run again to see them fire.",
  );
}

/** Write one company's signals and scan state. Returns signals written. */
async function persist(
  admin: SupabaseClient,
  result: Awaited<ReturnType<typeof scanRun>>["results"][number],
): Promise<number> {
  const saved = await upsertSignals(admin, result.companyId, result.signals);
  if (saved.error) console.error(`\n  ${result.companyName}: ${saved.error}`);

  const { error: scanError } = await admin.from("company_scans").upsert(
    {
      company_id: result.companyId,
      tech_stack: result.state.techStack,
      pricing_page_url: result.state.pricingPageUrl ?? null,
      pricing_page_hash: result.state.pricingPageHash ?? null,
      careers_page_url: result.state.careersPageUrl ?? null,
      careers_job_titles: result.state.careersJobTitles,
      revenue_ron: result.state.revenueRon ?? null,
      vat_registered: result.state.vatRegistered ?? null,
      keyword_hits: result.state.keywordHits ?? null,
      source_results: result.sourceResults,
      scan_status: result.status,
      consecutive_failures: result.consecutiveFailures,
      scanned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );
  if (scanError) console.error(`\n  ${result.companyName}: ${scanError.message}`);

  // `companies.tech_stack` has existed unwritten since the schema was created.
  // Filling it is what makes "which prospects run HubSpot right now" answerable
  // as a query rather than only as a signal.
  if (result.state.techStack.length > 0) {
    await admin
      .from("companies")
      .update({ tech_stack: result.state.techStack })
      .eq("id", result.companyId);
  }

  // A distress signal closes the loop into the sourcing query's
  // `.is("insolvency_status", null)` filter, so the company stops being sourced
  // rather than being sourced and then disqualified on every run.
  if (result.signals.some((s) => s.type === "insolvency_risk")) {
    await admin
      .from("companies")
      .update({ insolvency_status: "anaf_inactive" })
      .eq("id", result.companyId)
      .is("insolvency_status", null);
  }

  return saved.written;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
