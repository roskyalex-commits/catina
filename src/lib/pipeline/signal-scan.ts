import { fetchSiteSnapshot, SiteFetchError, type SiteSnapshot } from "@/lib/crawl/fetch-site";
import { SignalScanner, type ScanOutcome } from "@/lib/signals/scanner";
import type { ScanPerson, Signal, SignalSource } from "@/lib/signals/types";
import type { RegistryCompany } from "./source-run";

/**
 * One pass of signal scanning: companies → signals plus the state to diff against.
 *
 * **Bounded and synchronous, like `sourceRun`, and for the same reason.** One
 * invocation looks at a fixed number of companies and returns a cursor, so a
 * scan always finishes and a failure costs one page rather than a job nobody
 * can see.
 *
 * The IO lives behind `ScanRunDeps`, so the tiering, concurrency, memoisation
 * and state extraction here are testable against fakes rather than a database
 * and a few hundred live websites.
 *
 * What this does *not* do is write. `scripts/scan-signals.ts` owns persistence,
 * because `signals` and `company_scans` are shared reference data that only the
 * service role may write, and a pure planner is easier to trust than one that
 * both decides and mutates.
 */

export const DEFAULT_SCAN_LIMIT = 25;
/**
 * Companies scanned at once.
 *
 * Politeness is a per-host property and these are all different hosts, each
 * visited at most a handful of times — the same reasoning as `HARVEST_CONCURRENCY`
 * in `scripts/enrich-emails.ts`. Sources *within* one company stay sequential;
 * that is `SignalScanner`'s decision and ANAF's rate limit is per-process anyway.
 */
export const DEFAULT_SCAN_CONCURRENCY = 8;

/** A site down this many scans running is not worth another request. */
export const MAX_CONSECUTIVE_FAILURES = 4;

export type ScanPrevious = {
  techStack?: string[];
  pricingPageHash?: string;
  careersJobTitles?: string[];
  revenueRon?: number;
  vatRegistered?: boolean;
};

export type ScanCandidate = {
  company: RegistryCompany;
  /** What the last scan saw. Absent on a first scan, which is the common case. */
  previous?: ScanPrevious;
  /** Zero for now — the seam a person-level provider reads. */
  people: ScanPerson[];
  consecutiveFailures?: number;
};

/** What the agent is targeting, threaded into every source that cares. */
export type ScanTargeting = {
  targetTitles: string[];
  keywords: string[];
  competitorTech: string[];
  competitorNames: string[];
  /** Catalogue keys. Empty means every source. */
  enabledSignals: string[];
};

export function emptyTargeting(): ScanTargeting {
  return {
    targetTitles: [],
    keywords: [],
    competitorTech: [],
    competitorNames: [],
    enabledSignals: [],
  };
}

/** The state the next scan needs in order to diff. */
export type ScanState = {
  techStack: string[];
  pricingPageUrl?: string;
  pricingPageHash?: string;
  careersPageUrl?: string;
  careersJobTitles: string[];
  revenueRon?: number;
  vatRegistered?: boolean;
  keywordHits?: Record<string, unknown>;
};

export type CompanyScanResult = {
  companyId: string;
  companyName: string;
  domain?: string;
  signals: Signal[];
  sourceResults: ScanOutcome["sourceResults"];
  state: ScanState;
  status: "ok" | "unreachable" | "error";
  /** Carried through so the writer can apply backoff without re-reading. */
  consecutiveFailures: number;
};

export type ScanRunDeps = {
  /** Companies due a scan, ordered, cursor-paged. */
  findCandidates(
    limit: number,
    cursor?: string,
  ): Promise<{ candidates: ScanCandidate[]; cursor?: string; notes: string[] }>;

  /** The sources to run. Injected so a test can supply fakes. */
  sources(targeting: ScanTargeting): SignalSource[];

  /** Injected so tests need no network; defaults to the real crawler. */
  fetchSite?(domain: string): Promise<SiteSnapshot | null>;
};

export type ScanRunInput = {
  targeting: ScanTargeting;
  limit?: number;
  cursor?: string;
  concurrency?: number;
  /**
   * Read each company's website. Default true.
   *
   * Set false for a registry-only pass over companies with no domain, where
   * every web source would be skipped anyway.
   */
  web?: boolean;
};

export type ScanRunResult = {
  results: CompanyScanResult[];
  /** Companies skipped by backoff, not scanned. */
  backedOff: number;
  cursor?: string;
  notes: string[];
};

/**
 * A site reader that fetches at most once, however many sources ask.
 *
 * The tech-stack and pricing sources both want the same pages; before this they
 * fetched them independently. Returning null for an unreachable site rather
 * than throwing is deliberate — most prospect sites are down, JavaScript-only
 * or blocking us, and that is an ordinary outcome for every source at once.
 */
function memoisedSite(
  domain: string | undefined,
  fetcher: (domain: string) => Promise<SiteSnapshot | null>,
): { read: () => Promise<SiteSnapshot | null>; wasRead: () => boolean; snapshot: () => SiteSnapshot | null } {
  let started: Promise<SiteSnapshot | null> | undefined;
  let resolved: SiteSnapshot | null = null;

  return {
    read: () => {
      if (!domain) return Promise.resolve(null);
      started ??= fetcher(domain).then((snapshot) => {
        resolved = snapshot;
        return snapshot;
      });
      return started;
    },
    wasRead: () => started !== undefined,
    snapshot: () => resolved,
  };
}

async function defaultFetchSite(domain: string): Promise<SiteSnapshot | null> {
  try {
    return await fetchSiteSnapshot(domain);
  } catch (error) {
    if (error instanceof SiteFetchError) return null;
    throw error;
  }
}

/** Scan one page of companies. */
export async function scanRun(
  deps: ScanRunDeps,
  input: ScanRunInput,
): Promise<ScanRunResult> {
  const limit = input.limit ?? DEFAULT_SCAN_LIMIT;
  const { candidates, cursor, notes } = await deps.findCandidates(limit, input.cursor);

  const due = candidates.filter(
    (candidate) => (candidate.consecutiveFailures ?? 0) < MAX_CONSECUTIVE_FAILURES,
  );
  const backedOff = candidates.length - due.length;

  const scanner = new SignalScanner(deps.sources(input.targeting));
  const fetchSite = deps.fetchSite ?? defaultFetchSite;

  const results = await pooled(
    due,
    (candidate) =>
      scanOne(candidate, scanner, input.targeting, fetchSite, input.web !== false),
    input.concurrency ?? DEFAULT_SCAN_CONCURRENCY,
  );

  return { results, backedOff, cursor, notes };
}

async function scanOne(
  candidate: ScanCandidate,
  scanner: SignalScanner,
  targeting: ScanTargeting,
  fetchSite: (domain: string) => Promise<SiteSnapshot | null>,
  web: boolean,
): Promise<CompanyScanResult> {
  const { company } = candidate;
  const site = memoisedSite(company.domain, fetchSite);

  /*
   * Read the site up front rather than leaving it to whichever source happens
   * to want it.
   *
   * The stored tech stack is state, not a by-product: it is what the *next*
   * scan diffs against. Recording it only when some source happened to read the
   * page meant a scan with no web sources enabled stored an empty stack — and
   * the scan after that reported every technology as newly added. The memo makes
   * this free when a source reads it too.
   */
  if (web && company.domain) await site.read();

  let outcome: ScanOutcome;
  try {
    outcome = await scanner.scan({
      company,
      previous: candidate.previous,
      targetTitles: targeting.targetTitles,
      keywords: targeting.keywords,
      competitorTech: targeting.competitorTech,
      competitorNames: targeting.competitorNames,
      people: candidate.people,
      site: site.read,
    });
  } catch (error) {
    // The scanner isolates each source, so reaching here means something
    // structural. One company must not take the page down with it.
    return {
      companyId: company.id,
      companyName: company.name,
      domain: company.domain,
      signals: [],
      sourceResults: [
        {
          source: "scanner",
          status: "error",
          signalCount: 0,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      state: stateFrom(candidate, null),
      status: "error",
      consecutiveFailures: (candidate.consecutiveFailures ?? 0) + 1,
    };
  }

  const snapshot = site.snapshot();
  // Unreachable only when a source actually tried and got nothing back. A
  // company with no domain was never going to be read, and calling that a
  // failure would back it off forever for a reason it cannot fix.
  const unreachable = Boolean(company.domain) && site.wasRead() && snapshot === null;

  return {
    companyId: company.id,
    companyName: company.name,
    domain: company.domain,
    signals: outcome.signals,
    sourceResults: outcome.sourceResults,
    state: stateFrom(candidate, snapshot, outcome),
    status: unreachable ? "unreachable" : "ok",
    consecutiveFailures: unreachable ? (candidate.consecutiveFailures ?? 0) + 1 : 0,
  };
}

/**
 * What to store for the next diff.
 *
 * Carries the previous values forward when this scan learned nothing new, so a
 * single unreachable scan does not erase a stack recorded last month and make
 * every technology look newly added on the scan after.
 */
function stateFrom(
  candidate: ScanCandidate,
  snapshot: SiteSnapshot | null,
  outcome?: ScanOutcome,
): ScanState {
  const previous = candidate.previous;
  const pricing = outcome?.signals.find((s) => s.type === "pricing_page_changed");
  const hiring = outcome?.signals.find(
    (s) => s.type === "hiring_surge" || s.type === "hiring_buyer_role",
  );

  const pricingPage = snapshot?.pages.find((p) => /pricing|preturi|tarife/i.test(p.url));
  const keywords = outcome?.signals.find((s) => s.type === "keyword_on_site");

  return {
    techStack: snapshot?.techStack ?? previous?.techStack ?? [],
    pricingPageUrl:
      (pricing?.payload?.pricingPageUrl as string | undefined) ?? pricingPage?.url,
    pricingPageHash:
      (pricing?.payload?.currentHash as string | undefined) ?? previous?.pricingPageHash,
    careersPageUrl: hiring?.evidenceUrl,
    careersJobTitles:
      (hiring?.payload?.titles as string[] | undefined) ??
      previous?.careersJobTitles ??
      [],
    // Copied from the row at scan time so the next scan compares against what
    // this one saw. Reading `companies` live at diff time compares a value with
    // itself and never fires.
    revenueRon: candidate.company.revenueRon,
    vatRegistered: candidate.company.vatRegistered,
    /*
     * Not a diff input — nothing compares keyword hits between scans. It is
     * stored because it is the cheapest possible answer to "why did this
     * company surface", and re-deriving it means re-fetching the site. The
     * signal's payload holds the same thing, but signals age out and a scan row
     * does not.
     */
    keywordHits: keywords?.payload
      ? (keywords.payload as Record<string, unknown>)
      : undefined,
  };
}

/** Run `worker` over `items`, at most `concurrency` at a time, preserving order. */
async function pooled<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}
