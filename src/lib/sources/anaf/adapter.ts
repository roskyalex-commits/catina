import type { SupabaseClient } from "@supabase/supabase-js";
import type { Icp } from "@/lib/icp/schema";
import { caenDivisions, caenLabel } from "@/lib/sources/caen";
import type {
  LeadSourceAdapter,
  SearchQuery,
  SearchResult,
  SourcedCompany,
} from "@/lib/sources/types";
import { AnafClient, type AnafCompany } from "./client";

/**
 * Romanian registry lead source.
 *
 * Discovery and enrichment come from different places, because ANAF's API is
 * lookup-by-CUI only — you cannot ask it "which companies have CAEN 6201".
 * So:
 *   - discovery queries our own `companies` table, seeded from the ONRC bulk
 *     dataset on data.gov.ro (free, every registered Romanian company)
 *   - enrichment calls ANAF per CUI for the live fields that matter and that
 *     the bulk export does not carry: VAT status, e-Factura, inactive flag,
 *     and the annual financial statement
 *
 * Both halves are free and need no API key, which is what makes the Romanian
 * market viable at zero data cost.
 */
export class AnafAdapter implements LeadSourceAdapter {
  readonly key = "anaf";
  readonly label = "Romanian company registry (ANAF/ONRC)";

  constructor(
    private readonly db: SupabaseClient,
    private readonly client: AnafClient = new AnafClient(),
  ) {}

  /** Romania-only by construction — an ICP that excludes RO gets nothing here. */
  isAvailable(icp: Icp): boolean {
    return icp.countries.includes("RO");
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const { icp, limit, cursor } = query;
    const notes: string[] = [];

    if (!this.isAvailable(icp)) {
      return {
        companies: [],
        notes: ["Romanian registry skipped: RO is not in the ICP's markets."],
      };
    }

    let companies = await this.queryRegistry(icp, limit, cursor, icp.caenCodes);

    // An exact-code query is often too narrow: an ICP built around "6201
    // custom software" almost always wants 6202 and 6209 too. Widen once
    // before giving up, and say so rather than silently changing the filter.
    if (companies.length < limit / 2 && icp.caenCodes.length > 0) {
      const divisions = caenDivisions(icp.caenCodes);
      const widened = await this.queryRegistryByDivision(
        icp,
        limit,
        cursor,
        divisions,
      );
      if (widened.length > companies.length) {
        notes.push(
          `Exact CAEN codes returned ${companies.length} companies, so the ` +
            `search was widened to divisions ${divisions.join(", ")}.`,
        );
        companies = widened;
      }
    }

    if (icp.caenCodes.length === 0) {
      notes.push(
        "No CAEN codes on the ICP — registry search fell back to keyword " +
          "matching, which is much less precise. Add codes in step 2.",
      );
    }

    return { companies, cursor: nextCursor(companies, cursor), notes };
  }

  /**
   * Live ANAF enrichment for one company. Adds the fields the bulk registry
   * export does not carry and that go stale fastest.
   */
  async enrichCompany(company: SourcedCompany): Promise<SourcedCompany> {
    if (!company.cui) return company;

    const [registry, growth] = await Promise.all([
      this.client.lookupOne(company.cui),
      this.client
        .fetchRevenueGrowth(company.cui)
        // Financials are a bonus, not a requirement — an unfiled year must not
        // fail the whole enrichment.
        .catch(() => null),
    ]);

    if (!registry) return company;

    return {
      ...company,
      ...mapRegistry(registry),
      revenueRon: growth?.latest.revenueRon ?? company.revenueRon,
      revenuePrevRon: growth?.previous.revenueRon ?? company.revenuePrevRon,
      profitRon: growth?.latest.profitRon ?? company.profitRon,
      employeesAnaf: growth?.latest.employees ?? company.employeesAnaf,
      financialsYear: growth?.latest.year ?? company.financialsYear,
    };
  }

  private baseQuery(icp: Icp, limit: number, cursor?: string) {
    let q = this.db
      .from("companies")
      .select("*")
      .eq("country", "RO")
      // An insolvent company is not a lead. Filtering here rather than at
      // scoring time keeps them out of credit-consuming enrichment entirely.
      .is("insolvency_status", null)
      .order("id", { ascending: true })
      .limit(limit);

    if (cursor) q = q.gt("id", cursor);

    if (icp.employeeMin !== null) {
      q = q.gte("employees_anaf", icp.employeeMin);
    }
    if (icp.employeeMax !== null) {
      q = q.lte("employees_anaf", icp.employeeMax);
    }
    if (icp.revenueMinRon !== null) {
      q = q.gte("revenue_ron", icp.revenueMinRon);
    }
    if (icp.revenueMaxRon !== null) {
      q = q.lte("revenue_ron", icp.revenueMaxRon);
    }
    return q;
  }

  private async queryRegistry(
    icp: Icp,
    limit: number,
    cursor: string | undefined,
    caenCodes: string[],
  ): Promise<SourcedCompany[]> {
    let q = this.baseQuery(icp, limit, cursor);

    if (caenCodes.length > 0) {
      q = q.in("caen", caenCodes);
    } else if (icp.keywords.length > 0) {
      // Weakest path, and flagged as such in `notes`.
      const pattern = icp.keywords
        .slice(0, 5)
        .map((k) => `name.ilike.%${escapeLike(k)}%`)
        .join(",");
      q = q.or(pattern);
    }

    const { data, error } = await q;
    if (error) throw new Error(`Registry query failed: ${error.message}`);
    return (data ?? []).map(rowToCompany);
  }

  private async queryRegistryByDivision(
    icp: Icp,
    limit: number,
    cursor: string | undefined,
    divisions: string[],
  ): Promise<SourcedCompany[]> {
    if (divisions.length === 0) return [];

    // PostgREST has no "starts with any of" — one ilike per division, OR'd.
    const pattern = divisions.map((d) => `caen.like.${d}%`).join(",");
    const { data, error } = await this.baseQuery(icp, limit, cursor).or(pattern);

    if (error) throw new Error(`Registry query failed: ${error.message}`);
    return (data ?? []).map(rowToCompany);
  }
}

/** PostgREST `or()` filters are comma-separated, so commas must not leak in. */
function escapeLike(value: string): string {
  return value.replace(/[,()%_]/g, " ").trim();
}

function nextCursor(
  companies: SourcedCompany[],
  previous: string | undefined,
): string | undefined {
  const last = companies.at(-1);
  return last?.dedupeKey ? last.dedupeKey : previous;
}

function mapRegistry(registry: AnafCompany): Partial<SourcedCompany> {
  return {
    name: registry.name,
    city: registry.city,
    county: registry.county,
    regCom: registry.regCom,
    caen: registry.caen,
    caenLabel: registry.caen ? caenLabel(registry.caen) : undefined,
    vatRegistered: registry.vatRegistered,
    vatOnCollection: registry.vatOnCollection,
    eFacturaRegistered: registry.eFacturaRegistered,
    registrationDate: registry.registrationDate,
    // ANAF's inactive-taxpayer register is the earliest public distress
    // signal — treat it as disqualifying until BPI confirms otherwise.
    insolvencyStatus: registry.inactive ? "anaf_inactive" : null,
  };
}

type CompanyRow = Record<string, unknown>;

function rowToCompany(row: CompanyRow): SourcedCompany {
  const str = (key: string) =>
    typeof row[key] === "string" ? (row[key] as string) : undefined;
  const num = (key: string) => {
    const value = row[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  };
  const bool = (key: string) =>
    typeof row[key] === "boolean" ? (row[key] as boolean) : undefined;

  const caen = str("caen");

  return {
    dedupeKey: str("domain") ?? `cui:${str("cui") ?? row.id}`,
    name: str("name") ?? "",
    domain: str("domain"),
    website: str("website"),
    country: str("country") ?? "RO",
    city: str("city"),
    county: str("county"),
    description: str("description"),
    industry: str("industry"),
    employeeCount: num("employee_count"),
    linkedinUrl: str("linkedin_url"),
    cui: str("cui"),
    regCom: str("reg_com"),
    caen,
    caenLabel: caen ? caenLabel(caen) : undefined,
    vatRegistered: bool("vat_registered"),
    vatOnCollection: bool("vat_on_collection"),
    eFacturaRegistered: bool("e_factura_registered"),
    insolvencyStatus: str("insolvency_status") ?? null,
    registrationDate: str("registration_date"),
    revenueRon: num("revenue_ron"),
    revenuePrevRon: num("revenue_prev_ron"),
    profitRon: num("profit_ron"),
    employeesAnaf: num("employees_anaf"),
    financialsYear: num("financials_year"),
    source: "anaf",
  };
}
