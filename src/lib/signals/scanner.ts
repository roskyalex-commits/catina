import type { AnafClient } from "@/lib/sources/anaf/client";
import {
  AnafGrowthFromRowSource,
  AnafStatusFromRowSource,
} from "./sources/anaf-row";
import {
  AnafGrowthSignalSource,
  AnafStatusSignalSource,
  NewRegistrationSignalSource,
} from "./sources/anaf";
import {
  CompetitorMentionSignalSource,
  CompetitorTechSignalSource,
} from "./sources/competitor";
import { HiringSignalSource } from "./sources/hiring";
import { KeywordNewsSignalSource, KeywordSiteSignalSource } from "./sources/keywords";
import { NewsSignalSource } from "./sources/news";
import { PersonEngagementSignalSource } from "./sources/person-engagement";
import { PricingPageSignalSource, TechStackSignalSource } from "./sources/website";
import type { CreditLedger } from "@/lib/enrichment/ledger";
import type { PersonSignalProvider } from "./providers/types";
import type { Signal, SignalScanContext, SignalSource } from "./types";

/**
 * Runs signal sources over one company.
 *
 * Every source is independent and network-bound, so the scanner's real job is
 * isolation: one slow or broken source must not cost the whole scan. A company
 * with a working ANAF filing and a dead careers page should still get its
 * revenue-growth signal.
 */

export type ScanOutcome = {
  signals: Signal[];
  /** Per-source result, so a persistently failing source is visible. */
  sourceResults: {
    source: string;
    status: "ok" | "skipped" | "error";
    signalCount: number;
    detail?: string;
  }[];
};

const SOURCE_TIMEOUT_MS = 20_000;

export class SignalScanner {
  constructor(private readonly sources: SignalSource[]) {}

  async scan(context: SignalScanContext): Promise<ScanOutcome> {
    const signals: Signal[] = [];
    const sourceResults: ScanOutcome["sourceResults"] = [];

    // Sequential rather than parallel: sources share upstream rate limits
    // (ANAF allows ~1 request/second) and running them concurrently would
    // trip those limits for a scan that isn't latency-sensitive anyway.
    for (const source of this.sources) {
      if (!source.isApplicable(context)) {
        sourceResults.push({
          source: source.key,
          status: "skipped",
          signalCount: 0,
          detail: "not applicable to this company",
        });
        continue;
      }

      try {
        const found = await withTimeout(source.scan(context), SOURCE_TIMEOUT_MS);
        signals.push(...found);
        sourceResults.push({
          source: source.key,
          status: "ok",
          signalCount: found.length,
        });
      } catch (error) {
        sourceResults.push({
          source: source.key,
          status: "error",
          signalCount: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { signals: dedupe(signals), sourceResults };
  }
}

/**
 * Two sources can legitimately produce the same underlying event — a funding
 * round often appears as both news and a careers-page surge. The dedupe key is
 * what collapses them, keeping whichever is stronger.
 */
function dedupe(signals: Signal[]): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const signal of signals) {
    const existing = byKey.get(signal.dedupeKey);
    if (!existing || signal.strength > existing.strength) {
      byKey.set(signal.dedupeKey, signal);
    }
  }
  return [...byKey.values()].sort((a, b) => b.strength - a.strength);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every source the product offers, in the order they appear in onboarding
 * step 4. Cheap and high-signal first.
 *
 * Note what is absent: LinkedIn. The competitor's signals are almost entirely
 * social engagement, which needs either a paid API or a ToS-violating scraper.
 * Everything here is free, official or first-party, and every signal links to
 * a public source the user can check.
 */
export function allSignalSources(anaf: AnafClient): SignalSource[] {
  return [
    new AnafGrowthSignalSource(anaf),
    new AnafStatusSignalSource(anaf),
    new NewRegistrationSignalSource(),
    new HiringSignalSource(),
    new NewsSignalSource("ro"),
    new TechStackSignalSource(),
    new PricingPageSignalSource(),
  ];
}

export type SourceSelection = {
  /**
   * Catalogue keys the agent enabled. Empty or absent means every source.
   *
   * Filtering here rather than inside the scanner keeps `SignalScanner`
   * ignorant of the catalogue: it runs what it is given, and the caller owns
   * the policy about which sources an agent pays for.
   */
  enabled?: string[];
  /**
   * A live ANAF client. Omit it — the usual case — and the registry signals are
   * computed from the enriched `companies` row instead, with no HTTP at all.
   *
   * `AnafClient` serialises every request at ~1.1s, and the growth source alone
   * makes two. Passing a client turns a scan that is bound by nothing into one
   * bound by a rate limit, so it belongs behind an explicit flag rather than
   * being the default.
   */
  anaf?: AnafClient;
  /**
   * Paid person-level providers. Empty today — see `providers/registry.ts`.
   *
   * Threaded through rather than constructed here so that connecting one is a
   * change to the registry and to whoever owns the budget, and not a change to
   * the scanner.
   */
  personProviders?: PersonSignalProvider[];
  /** Budget for those providers. Absent means unmetered. */
  ledger?: CreditLedger;
};

/**
 * The sources a scan should run.
 *
 * `allSignalSources` keeps its signature and its live-ANAF behaviour because it
 * is what the tests drive. This is the one the pipeline calls.
 */
export function selectSignalSources(selection: SourceSelection = {}): SignalSource[] {
  const registry = selection.anaf
    ? [
        new AnafGrowthSignalSource(selection.anaf),
        new AnafStatusSignalSource(selection.anaf),
      ]
    : [new AnafGrowthFromRowSource(), new AnafStatusFromRowSource()];

  const all: SignalSource[] = [
    /*
     * Keyword and competitor sources lead, and not only for the picker's sake.
     * Both read the snapshot the scan already fetched and fire on a *first*
     * pass, while four of the seven below can produce nothing until a company
     * has been scanned twice. Running them first means a scan that is cut short
     * still produced the signals worth having.
     */
    new KeywordSiteSignalSource(),
    new CompetitorTechSignalSource(),
    new CompetitorMentionSignalSource(),
    ...registry,
    new NewRegistrationSignalSource(),
    new HiringSignalSource(),
    new NewsSignalSource("ro"),
    new KeywordNewsSignalSource("ro"),
    new TechStackSignalSource(),
    new PricingPageSignalSource(),
    new PersonEngagementSignalSource({
      providers: selection.personProviders ?? [],
      ledger: selection.ledger,
    }),
  ];

  const enabled = selection.enabled;
  if (!enabled || enabled.length === 0) return all;
  return all.filter((source) => enabled.includes(source.key));
}

/**
 * The signal picker's menu, grouped the way a seller thinks about it.
 *
 * Built as data rather than derived from the source classes, because two of the
 * entries have no class to derive from: `person_engagement` has no provider
 * connected, and rendering it as a disabled row with a reason is the point. A
 * catalogue that only listed what currently works would quietly hide the two
 * categories the competitor leads on.
 *
 * `available: false` means "we know exactly what this is and what it costs, and
 * it is off". It is never a placeholder for something unbuilt.
 */
export type SignalCategory = "needs" | "competitors" | "company" | "registry" | "people";

export const SIGNAL_CATEGORY_LABELS: Record<SignalCategory, string> = {
  needs: "What they need",
  competitors: "Who they already pay",
  company: "What just changed",
  registry: "Official filings",
  people: "People",
};

export type SignalCatalogueEntry = {
  key: string;
  label: string;
  description: string;
  category: SignalCategory;
  romaniaOnly: boolean;
  /** False renders a disabled row carrying `unavailableReason`. */
  available: boolean;
  unavailableReason?: string;
  /**
   * True when the source needs a second scan before it can ever fire.
   *
   * Worth surfacing: a user who enables only diff-gated signals and sees an
   * empty first run has been failed by the UI, not by the data.
   */
  needsPreviousScan?: boolean;
};

export const SIGNAL_SOURCE_CATALOGUE: SignalCatalogueEntry[] = [
  {
    key: "keyword_site",
    label: "Keywords on their website",
    description:
      "Matches the topics your buyers care about against what a company actually says it does. Fires on the first scan and links to the sentence it found.",
    category: "needs",
    romaniaOnly: false,
    available: true,
  },
  {
    key: "keyword_news",
    label: "Keywords in the news",
    description:
      "Coverage that mentions a company alongside your topics — not just funding rounds. Free, no API key.",
    category: "needs",
    romaniaOnly: false,
    available: true,
  },
  {
    key: "competitor_tech",
    label: "Uses a competing product",
    description:
      "Detects competitors you name running on a prospect's site today. A company already paying for the category is the shortest path to a sale.",
    category: "competitors",
    romaniaOnly: false,
    available: true,
  },
  {
    key: "competitor_mention",
    label: "Mentions a competitor",
    description:
      "Finds competitors named in a prospect's own copy, for the ones that ship no detectable script. Weaker than a fingerprint — the snippet tells you why.",
    category: "competitors",
    romaniaOnly: false,
    available: true,
  },
  {
    key: "anaf_growth",
    label: "Revenue growth (ANAF filings)",
    description:
      "Year-over-year revenue change from official annual filings. Objective, free, and unavailable to international tools.",
    category: "registry",
    romaniaOnly: true,
    available: true,
  },
  {
    key: "anaf_status",
    label: "Registry status changes (VAT, insolvency)",
    description:
      "New VAT registration usually means a revenue threshold was crossed. The inactive-taxpayer list is the earliest public distress signal.",
    category: "registry",
    romaniaOnly: true,
    available: true,
  },
  {
    key: "onrc_new",
    label: "Newly registered companies",
    description:
      "Companies incorporated in the last few months — the moment founders choose the tools they'll keep for years.",
    category: "registry",
    romaniaOnly: true,
    available: true,
  },
  {
    key: "hiring",
    label: "Hiring activity",
    description:
      "Reads the company's own careers page. A company hiring has budget; a company hiring your buyer is about to have a new decision-maker.",
    category: "company",
    romaniaOnly: false,
    available: true,
  },
  {
    key: "news",
    label: "Funding and expansion news",
    description:
      "Watches Google News for funding rounds, acquisitions and expansion, in Romanian and English. Free, no API key.",
    category: "company",
    romaniaOnly: false,
    available: true,
  },
  {
    key: "tech_stack",
    label: "Technology changes",
    description:
      "Detects when a company adopts or drops a platform. Migrating stacks means budget is moving in that category right now.",
    category: "company",
    romaniaOnly: false,
    available: true,
    needsPreviousScan: true,
  },
  {
    key: "pricing_page",
    label: "Pricing page changes",
    description:
      "Flags when a company changes its pricing or packaging — often the run-up to a bigger push.",
    category: "company",
    romaniaOnly: false,
    available: true,
    needsPreviousScan: true,
  },
  {
    key: "person_engagement",
    label: "People engaging with your market",
    description:
      "Decision-makers who engaged publicly with content about your topics, or with a competitor's post.",
    category: "people",
    romaniaOnly: false,
    available: false,
    unavailableReason:
      "Needs a paid LinkedIn data provider. No public, free, legal source " +
      "publishes who engaged with a post — so this stays visibly off rather " +
      "than being approximated. Everything behind it is built: connect a key " +
      "in providers/registry.ts and it turns on.",
  },
];

/** Keys a scan can actually run today. What the picker defaults to. */
export const AVAILABLE_SIGNAL_KEYS: string[] = SIGNAL_SOURCE_CATALOGUE.filter(
  (entry) => entry.available,
).map((entry) => entry.key);
