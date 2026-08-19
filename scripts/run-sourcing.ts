/**
 * Runs sourcing for an agent from the command line.
 *
 *   npm run source -- --list                      # agents in the workspace
 *   npm run source -- --create "Cluj software"    # make one from the registry
 *   npm run source -- --agent <id> --pages 4      # source, 25 companies a page
 *
 * The same pipeline the HTTP route uses, driven without a browser. Useful for
 * seeding a workspace before the launch button exists, and it is the shape the
 * scheduled runner will take when cron handlers land.
 *
 * Uses the service role, because there is no user session on a command line.
 * That is the one difference from the route, and the reason this is an
 * operator's tool rather than something the app calls.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { icpSchema, type Icp } from "@/lib/icp/schema";
import {
  sourceRun,
  type RegistryCompany,
  type RegistryPerson,
  type SourceRunDeps,
} from "@/lib/pipeline/source-run";
import { findSignalsFor } from "@/lib/signals/repository";
import { requireEnv } from "./load-env";

const PAGE_SIZE = 25;

type Options = {
  list: boolean;
  create?: string;
  agentId?: string;
  pages: number;
  /** Only source companies we have a website for. */
  contactable: boolean;
  caen: string[];
};

function parseArgs(argv: string[]): Options {
  const options: Options = { list: false, pages: 1, contactable: false, caen: ["6201", "6202", "6203", "6209", "6210"] };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--list":
        options.list = true;
        break;
      case "--contactable":
        options.contactable = true;
        break;
      case "--create":
        options.create = next();
        break;
      case "--agent":
        options.agentId = next();
        break;
      case "--pages":
        options.pages = Math.max(1, Number(next()));
        break;
      case "--caen":
        options.caen = next().split(",").map((code) => code.trim()).filter(Boolean);
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

const db: SupabaseClient = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const COMPANY_COLUMNS =
  "id, name, domain, website, country, county, city, cui, reg_com, caen, caen_label, vat_registered, e_factura_registered, insolvency_status, registration_date, revenue_ron, revenue_prev_ron, employees_anaf, financials_year";

function icpFrom(row: Record<string, unknown>): Icp {
  const arr = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return icpSchema.parse({
    valueProp: (row.value_prop as string) || "Not set",
    targetTitles: arr(row.target_titles),
    targetSeniorities: arr(row.target_seniorities),
    industries: arr(row.industries),
    caenCodes: arr(row.caen_codes),
    companyTypes: arr(row.company_types),
    countries: arr(row.countries),
    keywords: arr(row.keywords),
    exclusions: arr(row.exclusions),
    employeeMin: row.employee_min === null ? null : Number(row.employee_min),
    employeeMax: row.employee_max === null ? null : Number(row.employee_max),
    revenueMinRon: row.revenue_min_ron === null ? null : Number(row.revenue_min_ron),
    revenueMaxRon: row.revenue_max_ron === null ? null : Number(row.revenue_max_ron),
    confidence: row.confidence === null ? 0.5 : Number(row.confidence),
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const { data: orgs } = await db.from("orgs").select("id, name, slug").limit(5);
  const org = (orgs ?? [])[0] as { id: string; name: string } | undefined;
  if (!org) {
    console.error("No workspace found. Sign up in the app first.");
    process.exit(1);
  }

  if (options.create) {
    const { data, error } = await db
      .from("agents")
      .insert({
        org_id: org.id,
        name: options.create,
        website_url: "https://example.ro",
        value_prop:
          "We sell bookkeeping and invoicing automation to Romanian companies.",
        target_titles: ["Administrator"],
        target_seniorities: ["c_level"],
        caen_codes: options.caen,
        countries: ["RO"],
        keywords: ["software", "IT"],
        status: "active",
      })
      .select("id, name")
      .single();
    if (error) {
      console.error(`Could not create the agent: ${error.message}`);
      process.exit(1);
    }
    console.log(`Created agent ${data!.name}  ${data!.id}`);
    options.agentId ??= data!.id as string;
  }

  if (options.list || !options.agentId) {
    const { data } = await db
      .from("agents")
      .select("id, name, status, caen_codes")
      .eq("org_id", org.id);
    console.log(`Agents in ${org.name}:`);
    for (const agent of (data ?? []) as Record<string, unknown>[]) {
      console.log(`  ${agent.id}  ${agent.name}  [${agent.status}]  caen=${agent.caen_codes}`);
    }
    if (!options.agentId) return;
  }

  const { data: agentRow } = await db
    .from("agents")
    .select("*")
    .eq("id", options.agentId)
    .single();
  if (!agentRow) {
    console.error("No such agent.");
    process.exit(1);
  }

  const icp = icpFrom(agentRow as Record<string, unknown>);

  const deps: SourceRunDeps = {
    async findCompanies(currentIcp, limit, cursor) {
      let query = db
        .from("companies")
        .select(COMPANY_COLUMNS)
        .eq("country", "RO")
        .is("insolvency_status", null)
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor) query = query.gt("id", cursor);
      // See the note on `contactableOnly` in the sourcing route: a company with
      // no website cannot be emailed by any free route, so it cannot clear 45.
      if (options.contactable) query = query.not("domain", "is", null);
      if (currentIcp.caenCodes.length) query = query.in("caen", currentIcp.caenCodes);

      const { data, error } = await query;
      if (error) throw error;
      const companies = (data ?? []).map((row): RegistryCompany => {
        const company = row as Record<string, unknown>;
        return {
          id: String(company.id),
          dedupeKey: `cui:${company.cui}`,
          name: String(company.name),
          domain: (company.domain as string) ?? undefined,
          country: (company.country as string) ?? undefined,
          county: (company.county as string) ?? undefined,
          city: (company.city as string) ?? undefined,
          cui: (company.cui as string) ?? undefined,
          regCom: (company.reg_com as string) ?? undefined,
          caen: (company.caen as string) ?? undefined,
          caenLabel: (company.caen_label as string) ?? undefined,
          vatRegistered: (company.vat_registered as boolean) ?? undefined,
          revenueRon: company.revenue_ron === null ? undefined : Number(company.revenue_ron),
          employeesAnaf:
            company.employees_anaf === null ? undefined : Number(company.employees_anaf),
          source: "onrc",
        };
      });
      return { companies, cursor: companies.at(-1)?.id, notes: [] };
    },

    async findPeople(companyIds) {
      const { data, error } = await db
        .from("people")
        .select("id, company_id, full_name, title, seniority")
        .in("company_id", companyIds);
      if (error) throw error;
      return (data ?? []).map((row): RegistryPerson => {
        const person = row as Record<string, unknown>;
        return {
          id: String(person.id),
          companyId: String(person.company_id),
          fullName: String(person.full_name),
          title: (person.title as string) ?? undefined,
          seniority: (person.seniority as string) ?? undefined,
        };
      });
    },

    async findSignals(companyIds) {
      return findSignalsFor(db, companyIds);
    },

    async existingPersonIds(personIds) {
      if (!personIds.length) return new Set();
      const { data } = await db
        .from("leads")
        .select("person_id")
        .eq("agent_id", options.agentId!)
        .in("person_id", personIds);
      return new Set(
        (data ?? [])
          .map((row) => (row as { person_id: string | null }).person_id)
          .filter((id): id is string => Boolean(id)),
      );
    },
  };

  let cursor: string | undefined;
  let total = 0;

  for (let page = 1; page <= options.pages; page += 1) {
    const result = await sourceRun(deps, { icp, limit: PAGE_SIZE, cursor });

    if (result.leads.length) {
      const { error } = await db.from("leads").insert(
        result.leads.map((lead) => ({
          org_id: org.id,
          agent_id: options.agentId,
          company_id: lead.companyId,
          person_id: lead.personId,
          score: lead.score,
          score_breakdown: lead.breakdown,
          compliance_region: lead.complianceRegion,
          source_label: lead.sourceLabel,
          source_query: lead.sourceQuery,
          status: "new",
        })),
      );
      if (error) {
        console.error(`Insert failed: ${error.message}`);
        process.exit(1);
      }
    }

    await db.from("job_runs").insert({
      org_id: org.id,
      agent_id: options.agentId,
      kind: "sourcing",
      status: "ok",
      title:
        result.leads.length > 0
          ? `${result.leads.length} new leads found`
          : "No new leads found",
      subtitle: result.leads[0]?.sourceQuery ?? String(agentRow.name),
      source_label: result.leads[0]?.sourceLabel ?? "autopilot",
      source_query: result.leads[0]?.sourceQuery ?? null,
      leads_found: result.leads.length,
      stats: {
        companiesConsidered: result.companiesConsidered,
        companiesWithoutContact: result.companiesWithoutContact,
        alreadyKnown: result.alreadyKnown,
        notes: result.notes,
      },
    });

    total += result.leads.length;
    console.log(
      `  page ${page}: ${result.leads.length} new from ${result.companiesConsidered} companies` +
        (result.alreadyKnown ? ` (${result.alreadyKnown} already known)` : ""),
    );
    for (const note of result.notes) console.log(`    note: ${note}`);

    cursor = result.cursor;
    if (!cursor || result.companiesConsidered === 0) break;
  }

  console.log(`\n✓ ${total} leads for ${agentRow.name}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
