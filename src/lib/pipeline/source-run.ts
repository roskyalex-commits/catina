import type { Icp } from "@/lib/icp/schema";
import { scoreLead, type ScoreBreakdown } from "@/lib/signals/scoring";
import type { Signal } from "@/lib/signals/types";
import type { SourcedCompany } from "@/lib/sources/types";

/**
 * One sourcing run: registry → scored leads.
 *
 * **Synchronous and bounded, deliberately.** Wiring five queue consumers before
 * a single lead exists means debugging the queue and the pipeline at the same
 * time. One invocation looks at a fixed number of companies and returns, and
 * the caller advances a cursor to continue — so a run always finishes inside a
 * request, and a failure loses one page rather than a job.
 *
 * The IO lives behind `SourceRunDeps`, so the ordering, scoring, deduplication
 * and cursor logic here can be tested against fakes rather than a database.
 */

export const DEFAULT_COMPANY_LIMIT = 25;

/** A lead the run wants to create, before it is written. */
export type PreparedLead = {
  companyId: string;
  personId: string | null;
  score: number;
  breakdown: ScoreBreakdown;
  complianceRegion: string | null;
  sourceLabel: string;
  sourceQuery: string | null;
  /** Display only — the caller does not write these. */
  companyName: string;
  personName: string | null;
};

export type RegistryCompany = SourcedCompany & { id: string };

export type RegistryPerson = {
  id: string;
  companyId: string;
  fullName: string;
  title?: string;
  seniority?: string;
};

export type SourceRunDeps = {
  /** Companies matching the ICP, already filtered and ordered stably. */
  findCompanies(
    icp: Icp,
    limit: number,
    cursor?: string,
  ): Promise<{ companies: RegistryCompany[]; cursor?: string; notes: string[] }>;

  /** Decision-makers at those companies. */
  findPeople(companyIds: string[]): Promise<RegistryPerson[]>;

  /** Signals already detected for those companies, if any. */
  findSignals?(companyIds: string[]): Promise<Map<string, Signal[]>>;

  /** Person ids this agent already has a lead for. */
  existingPersonIds(personIds: string[]): Promise<Set<string>>;
};

export type SourceRunInput = {
  icp: Icp;
  limit?: number;
  cursor?: string;
  now?: Date;
};

export type SourceRunResult = {
  leads: PreparedLead[];
  companiesConsidered: number;
  /** Companies that matched but had nobody to contact. */
  companiesWithoutContact: number;
  /** Leads skipped because this agent already has them. */
  alreadyKnown: number;
  cursor?: string;
  /** Surfaced in the UI rather than swallowed — why a run found little. */
  notes: string[];
};

/**
 * Which of a company's people to contact.
 *
 * One lead per company, not one per person: a company with four administrators
 * is one opportunity, and mailing all four is how a domain gets a reputation
 * problem. Preference goes to the most senior, then to the first by name so a
 * re-run picks the same person rather than shuffling.
 */
export function pickContact(people: RegistryPerson[]): RegistryPerson | undefined {
  if (people.length === 0) return undefined;

  const rank: Record<string, number> = {
    founder: 0,
    c_level: 1,
    vp: 2,
    director: 3,
    head: 4,
    manager: 5,
    individual_contributor: 6,
  };

  return [...people].sort((a, b) => {
    const byRank =
      (rank[a.seniority ?? ""] ?? 9) - (rank[b.seniority ?? ""] ?? 9);
    return byRank !== 0 ? byRank : a.fullName.localeCompare(b.fullName, "ro");
  })[0];
}

/**
 * What drove this match, for the chip under the lead.
 *
 * The registry search runs on CAEN codes when the ICP has them and falls back
 * to name matching when it does not, so the label reports what actually
 * happened rather than assuming.
 *
 * Note `icpSchema` only accepts 4-digit codes — a user cannot ask for "division
 * 62". Divisions arise inside the adapter, which widens when exact codes return
 * too few companies, so the second test here is the reachable one: the company
 * shares a division with something the user asked for.
 */
export function describeSource(
  icp: Icp,
  company: SourcedCompany,
): { label: string; query: string | null } {
  const caen = company.caen;
  if (icp.caenCodes.length > 0 && caen) {
    const exact = icp.caenCodes.includes(caen);
    const widened = icp.caenCodes.some(
      (code) => code.slice(0, 2) === caen.slice(0, 2),
    );
    if (exact || widened) {
      return { label: "keyword", query: `CAEN ${caen}` };
    }
  }
  if (icp.keywords.length > 0) {
    const hit = icp.keywords.find((keyword) =>
      company.name.toLowerCase().includes(keyword.toLowerCase()),
    );
    if (hit) return { label: "keyword", query: hit };
  }
  // Matched the ICP's structural filters — county, size, revenue — rather than
  // any one term the user typed.
  return { label: "autopilot", query: null };
}

/**
 * Run one page of sourcing.
 *
 * Does not write. The caller persists the result, which keeps this function
 * pure enough to test and lets the route decide the transaction boundary.
 */
export async function sourceRun(
  deps: SourceRunDeps,
  input: SourceRunInput,
): Promise<SourceRunResult> {
  const limit = input.limit ?? DEFAULT_COMPANY_LIMIT;
  const now = input.now ?? new Date();

  const { companies, cursor, notes } = await deps.findCompanies(
    input.icp,
    limit,
    input.cursor,
  );

  if (companies.length === 0) {
    return {
      leads: [],
      companiesConsidered: 0,
      companiesWithoutContact: 0,
      alreadyKnown: 0,
      cursor,
      notes: [
        ...notes,
        "No companies matched. Widen the CAEN codes or the size and revenue " +
          "bands, or import more of the registry.",
      ],
    };
  }

  const companyIds = companies.map((company) => company.id);
  const [people, signalsByCompany] = await Promise.all([
    deps.findPeople(companyIds),
    deps.findSignals?.(companyIds) ?? Promise.resolve(new Map<string, Signal[]>()),
  ]);

  const peopleByCompany = new Map<string, RegistryPerson[]>();
  for (const person of people) {
    const list = peopleByCompany.get(person.companyId) ?? [];
    list.push(person);
    peopleByCompany.set(person.companyId, list);
  }

  // Ask once for every candidate rather than per company: one round trip
  // instead of `limit` of them.
  const candidates = companies
    .map((company) => ({
      company,
      person: pickContact(peopleByCompany.get(company.id) ?? []),
    }))
    .filter((candidate) => candidate.person !== undefined);

  const known = await deps.existingPersonIds(
    candidates.map((candidate) => candidate.person!.id),
  );

  const leads: PreparedLead[] = [];
  let alreadyKnown = 0;

  for (const { company, person } of candidates) {
    if (known.has(person!.id)) {
      alreadyKnown += 1;
      continue;
    }

    const breakdown = scoreLead({
      icp: input.icp,
      company,
      person: { fullName: person!.fullName, title: person!.title },
      signals: signalsByCompany.get(company.id) ?? [],
      // No email yet: the registry carries a domain for about 1% of companies,
      // so contactability is genuinely low and the score should say so rather
      // than assume an address that has not been found.
      now,
    });

    const source = describeSource(input.icp, company);
    leads.push({
      companyId: company.id,
      personId: person!.id,
      score: breakdown.total,
      breakdown,
      complianceRegion: company.country ?? null,
      sourceLabel: source.label,
      sourceQuery: source.query,
      companyName: company.name,
      personName: person!.fullName,
    });
  }

  // Highest score first, so a capped review queue shows the best leads.
  leads.sort((a, b) => b.score - a.score);

  const withoutContact = companies.length - candidates.length;
  const runNotes = [...notes];
  if (withoutContact > 0) {
    runNotes.push(
      `${withoutContact} of ${companies.length} companies had no named ` +
        "contact in the register and were skipped.",
    );
  }

  return {
    leads,
    companiesConsidered: companies.length,
    companiesWithoutContact: withoutContact,
    alreadyKnown,
    cursor,
    notes: runNotes,
  };
}
