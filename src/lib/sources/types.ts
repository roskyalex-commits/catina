import type { Icp } from "@/lib/icp/schema";

/**
 * The lead-sourcing seam.
 *
 * Every source — Romanian registries, our own crawler, and later the paid
 * vendors (Apollo, Coresignal, PDL) — implements this. Adapters report their
 * own availability so a missing API key downgrades coverage instead of
 * throwing, which is what lets the app run with no provider keys configured.
 */

export type SourcedCompany = {
  /** Deduplication key. Prefer domain; fall back to `cui:<code>` for RO-only records. */
  dedupeKey: string;
  name: string;
  domain?: string;
  website?: string;
  country?: string;
  city?: string;
  county?: string;
  description?: string;
  industry?: string;
  employeeCount?: number;
  linkedinUrl?: string;
  techStack?: string[];

  // --- Romania-specific registry fields ---
  cui?: string;
  regCom?: string;
  caen?: string;
  caenLabel?: string;
  vatRegistered?: boolean;
  vatOnCollection?: boolean;
  eFacturaRegistered?: boolean;
  insolvencyStatus?: string | null;
  registrationDate?: string;
  revenueRon?: number;
  revenuePrevRon?: number;
  profitRon?: number;
  employeesAnaf?: number;
  financialsYear?: number;

  /** Adapter key that produced this record. */
  source: string;
};

export type SourcedPerson = {
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  seniority?: string;
  department?: string;
  linkedinUrl?: string;
  location?: string;
  source: string;
};

export type SearchQuery = {
  icp: Icp;
  limit: number;
  /** Opaque per-adapter pagination cursor. */
  cursor?: string;
};

export type SearchResult = {
  companies: SourcedCompany[];
  cursor?: string;
  /** Adapters that were skipped, and why — surfaced in the UI, not swallowed. */
  notes: string[];
};

export interface LeadSourceAdapter {
  /** Stable key, used in `provider_usage` and on `companies.source`. */
  readonly key: string;
  readonly label: string;

  /** False when a required key is missing, or the ICP is out of the adapter's scope. */
  isAvailable(icp: Icp): boolean;

  /** Discover companies matching the ICP. */
  search(query: SearchQuery): Promise<SearchResult>;

  /** Fill in detail for a company another adapter found. Optional. */
  enrichCompany?(company: SourcedCompany): Promise<SourcedCompany>;

  /** Find decision-makers at a company. Optional. */
  findPeople?(company: SourcedCompany, icp: Icp): Promise<SourcedPerson[]>;
}

export class SourceUnavailableError extends Error {
  constructor(
    readonly adapterKey: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}
