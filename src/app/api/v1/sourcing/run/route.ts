import { NextResponse } from "next/server";
import { z } from "zod";
import { isDatabaseConfigured } from "@/lib/env";
import { icpSchema, type Icp } from "@/lib/icp/schema";
import {
  DEFAULT_COMPANY_LIMIT,
  sourceRun,
  type RegistryCompany,
  type RegistryPerson,
  type SourceRunDeps,
} from "@/lib/pipeline/source-run";
import { findSignalsFor } from "@/lib/signals/repository";
import { getSessionContext } from "@/lib/supabase/server";
import {
  optionalNumber,
  optionalString,
  requireString,
  stringArray,
} from "@/lib/supabase/row";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/sourcing/run — turn the registry into scored leads for an agent.
 *
 * Bounded and synchronous by design (see `lib/pipeline/source-run.ts`): one
 * call considers at most `MAX_LIMIT` companies and returns a cursor. Repeat
 * calls to go further. That keeps a run inside a request and means a failure
 * costs one page rather than a queued job nobody can see.
 *
 * Everything runs on the caller's session, not the service role. Leads and
 * job_runs are tenant rows so RLS applies to them, while `companies` and
 * `people` are shared reference data any authenticated user may read — so no
 * part of this needs to bypass tenancy.
 */

const MAX_LIMIT = 50;

const bodySchema = z.object({
  agentId: z.uuid(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().max(100).optional(),
  /**
   * Only consider companies we have a website for.
   *
   * Contactability is 20% of a lead's score and is zero without an email, and
   * the free route to an email is crawling the company's own site — so a
   * company with no domain cannot clear 45 no matter how well it fits. Sourcing
   * those first turns the same quota of leads into reachable ones.
   *
   * A separate flag rather than a change of ordering, because the cursor is
   * `id`-based: re-ordering the query would break the pagination contract,
   * while filtering keeps it exactly stable within the narrowed set.
   */
  contactableOnly: z.boolean().optional(),
});

/** The columns the pipeline reads. Explicit so a schema change fails loudly. */
const COMPANY_COLUMNS =
  "id, name, domain, website, country, county, city, cui, reg_com, caen, caen_label, vat_registered, e_factura_registered, insolvency_status, onrc_status, registration_date, revenue_ron, revenue_prev_ron, employees_anaf, financials_year";

function toCompany(row: Record<string, unknown>): RegistryCompany {
  const cui = optionalString(row.cui);
  return {
    id: requireString(row.id, "id"),
    dedupeKey: cui ? `cui:${cui}` : requireString(row.id, "id"),
    name: requireString(row.name, "name"),
    domain: optionalString(row.domain) ?? undefined,
    website: optionalString(row.website) ?? undefined,
    country: optionalString(row.country) ?? undefined,
    county: optionalString(row.county) ?? undefined,
    city: optionalString(row.city) ?? undefined,
    cui: cui ?? undefined,
    regCom: optionalString(row.reg_com) ?? undefined,
    caen: optionalString(row.caen) ?? undefined,
    caenLabel: optionalString(row.caen_label) ?? undefined,
    vatRegistered: typeof row.vat_registered === "boolean" ? row.vat_registered : undefined,
    eFacturaRegistered:
      typeof row.e_factura_registered === "boolean" ? row.e_factura_registered : undefined,
    insolvencyStatus: optionalString(row.insolvency_status),
    registrationDate: optionalString(row.registration_date) ?? undefined,
    revenueRon: optionalNumber(row.revenue_ron) ?? undefined,
    revenuePrevRon: optionalNumber(row.revenue_prev_ron) ?? undefined,
    employeesAnaf: optionalNumber(row.employees_anaf) ?? undefined,
    financialsYear: optionalNumber(row.financials_year) ?? undefined,
    source: "onrc",
  };
}

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      {
        error:
          "Sourcing needs the database. Create the Supabase project, then run npm run db:setup.",
        code: "not_configured",
      },
      { status: 503 },
    );
  }

  let session;
  try {
    session = await getSessionContext();
  } catch (error) {
    console.error("Resolving the session threw", { error });
    return NextResponse.json(
      { error: "Could not reach the database. Try again in a moment." },
      { status: 503 },
    );
  }
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  if (!session.orgId) {
    return NextResponse.json(
      { error: "Your workspace is not set up yet. Reload to finish signing in." },
      { status: 409 },
    );
  }
  const { supabase, orgId } = session;

  let input;
  try {
    input = bodySchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Send { agentId, limit?, cursor? }.",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  try {
    // RLS scopes this to the caller's org, so a foreign agent id reads as
    // missing rather than as forbidden — which is the correct answer to give.
    const { data: agentRow, error: agentError } = await supabase
      .from("agents")
      .select(
        "id, name, value_prop, product_name, target_titles, target_seniorities, industries, industry_keys, caen_codes, caen_codes_overridden, countries, keywords, competitor_tech, competitor_names, exclusions, employee_min, employee_max, revenue_min_ron, revenue_max_ron, company_types, confidence",
      )
      .eq("id", input.agentId)
      .maybeSingle();

    if (agentError) throw agentError;
    if (!agentRow) {
      return NextResponse.json({ error: "No such agent." }, { status: 404 });
    }

    const row = agentRow as Record<string, unknown>;
    // Rebuilt through `icpSchema` rather than trusted: the row predates any
    // later tightening of the schema, and the pipeline's scoring assumes a
    // valid ICP.
    const icp: Icp = icpSchema.parse({
      valueProp: optionalString(row.value_prop) ?? "Not set",
      productName: optionalString(row.product_name) ?? undefined,
      targetTitles: stringArray(row.target_titles),
      targetSeniorities: stringArray(row.target_seniorities),
      industries: stringArray(row.industries),
      industryKeys: stringArray(row.industry_keys),
      caenCodes: stringArray(row.caen_codes),
      caenCodesOverridden: row.caen_codes_overridden === true,
      companyTypes: stringArray(row.company_types),
      countries: stringArray(row.countries),
      keywords: stringArray(row.keywords),
      competitorTech: stringArray(row.competitor_tech),
      competitorNames: stringArray(row.competitor_names),
      exclusions: stringArray(row.exclusions),
      employeeMin: optionalNumber(row.employee_min),
      employeeMax: optionalNumber(row.employee_max),
      revenueMinRon: optionalNumber(row.revenue_min_ron),
      revenueMaxRon: optionalNumber(row.revenue_max_ron),
      confidence: optionalNumber(row.confidence) ?? 0.5,
    });

    const deps: SourceRunDeps = {
      async findCompanies(currentIcp, limit, cursor) {
        const notes: string[] = [];
        let query = supabase
          .from("companies")
          .select(COMPANY_COLUMNS)
          .eq("country", "RO")
          // An insolvent company is not a lead, and filtering here keeps it out
          // of anything downstream that would spend credits on it.
          .is("insolvency_status", null)
          .order("id", { ascending: true })
          .limit(limit);

        if (cursor) query = query.gt("id", cursor);
        if (input.contactableOnly) query = query.not("domain", "is", null);
        if (currentIcp.caenCodes.length > 0) {
          query = query.in("caen", currentIcp.caenCodes);
        } else {
          notes.push(
            "This agent has no CAEN codes, so sourcing matched on size and " +
              "location alone. Add codes for far better targeting.",
          );
        }
        if (currentIcp.employeeMin !== null) {
          query = query.gte("employees_anaf", currentIcp.employeeMin);
        }
        if (currentIcp.employeeMax !== null) {
          query = query.lte("employees_anaf", currentIcp.employeeMax);
        }
        if (currentIcp.revenueMinRon !== null) {
          query = query.gte("revenue_ron", currentIcp.revenueMinRon);
        }
        if (currentIcp.revenueMaxRon !== null) {
          query = query.lte("revenue_ron", currentIcp.revenueMaxRon);
        }

        const { data, error } = await query;
        if (error) throw error;

        const companies = (data ?? []).map((company) =>
          toCompany(company as Record<string, unknown>),
        );
        return {
          companies,
          cursor: companies.at(-1)?.id,
          notes,
        };
      },

      async findPeople(companyIds) {
        const { data, error } = await supabase
          .from("people")
          .select("id, company_id, full_name, title, seniority")
          .in("company_id", companyIds);
        if (error) throw error;
        return (data ?? []).map((personRow): RegistryPerson => {
          const person = personRow as Record<string, unknown>;
          return {
            id: requireString(person.id, "id"),
            companyId: requireString(person.company_id, "company_id"),
            fullName: requireString(person.full_name, "full_name"),
            title: optionalString(person.title) ?? undefined,
            seniority: optionalString(person.seniority) ?? undefined,
          };
        });
      },

      async findSignals(companyIds) {
        // `signals` is shared reference data — `authenticated` may select it —
        // so this runs on the caller's session like everything else here.
        // Until this dep was supplied, scoreSignals returned a constant zero
        // for 35% of every lead's score.
        return findSignalsFor(supabase, companyIds);
      },

      async existingPersonIds(personIds) {
        if (personIds.length === 0) return new Set();
        const { data, error } = await supabase
          .from("leads")
          .select("person_id")
          .eq("agent_id", input.agentId)
          .in("person_id", personIds);
        if (error) throw error;
        return new Set(
          (data ?? [])
            .map((lead) => optionalString((lead as Record<string, unknown>).person_id))
            .filter((id): id is string => id !== null),
        );
      },
    };

    const result = await sourceRun(deps, {
      icp,
      limit: input.limit ?? DEFAULT_COMPANY_LIMIT,
      cursor: input.cursor,
    });

    if (result.leads.length > 0) {
      const { error: insertError } = await supabase.from("leads").insert(
        result.leads.map((lead) => ({
          org_id: orgId,
          agent_id: input.agentId,
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
      if (insertError) throw insertError;
    }

    // The activity feed reads job_runs, so a run that found nothing should
    // still be visible — "no new leads found" is information.
    const { error: runError } = await supabase.from("job_runs").insert({
      org_id: orgId,
      agent_id: input.agentId,
      kind: "sourcing",
      status: "ok",
      title:
        result.leads.length > 0
          ? `${result.leads.length} new leads found`
          : "No new leads found",
      subtitle: result.leads[0]?.sourceQuery ?? optionalString(row.name),
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
    if (runError) throw runError;

    return NextResponse.json({
      leadsCreated: result.leads.length,
      companiesConsidered: result.companiesConsidered,
      companiesWithoutContact: result.companiesWithoutContact,
      alreadyKnown: result.alreadyKnown,
      cursor: result.cursor,
      notes: result.notes,
      leads: result.leads.map((lead) => ({
        company: lead.companyName,
        person: lead.personName,
        score: lead.score,
        why: lead.sourceQuery,
      })),
    });
  } catch (error) {
    console.error("Sourcing run failed", { orgId, agentId: input.agentId, error });
    return NextResponse.json(
      { error: "The sourcing run failed. Try again in a moment." },
      { status: 500 },
    );
  }
}
