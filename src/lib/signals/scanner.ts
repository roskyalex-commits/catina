import type { AnafClient } from "@/lib/sources/anaf/client";
import {
  AnafGrowthSignalSource,
  AnafStatusSignalSource,
  NewRegistrationSignalSource,
} from "./sources/anaf";
import { HiringSignalSource } from "./sources/hiring";
import { NewsSignalSource } from "./sources/news";
import { PricingPageSignalSource, TechStackSignalSource } from "./sources/website";
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

/** Descriptions for the signal picker, without needing a client to build them. */
export const SIGNAL_SOURCE_CATALOGUE: {
  key: string;
  label: string;
  description: string;
  romaniaOnly: boolean;
}[] = [
  {
    key: "anaf_growth",
    label: "Revenue growth (ANAF filings)",
    description:
      "Year-over-year revenue change from official annual filings. Objective, free, and unavailable to international tools.",
    romaniaOnly: true,
  },
  {
    key: "anaf_status",
    label: "Registry status changes (VAT, insolvency)",
    description:
      "New VAT registration usually means a revenue threshold was crossed. The inactive-taxpayer list is the earliest public distress signal.",
    romaniaOnly: true,
  },
  {
    key: "onrc_new",
    label: "Newly registered companies",
    description:
      "Companies incorporated in the last few months — the moment founders choose the tools they'll keep for years.",
    romaniaOnly: true,
  },
  {
    key: "hiring",
    label: "Hiring activity",
    description:
      "Reads the company's own careers page. A company hiring has budget; a company hiring your buyer is about to have a new decision-maker.",
    romaniaOnly: false,
  },
  {
    key: "news",
    label: "Funding and expansion news",
    description:
      "Watches Google News for funding rounds, acquisitions and expansion, in Romanian and English. Free, no API key.",
    romaniaOnly: false,
  },
  {
    key: "tech_stack",
    label: "Technology changes",
    description:
      "Detects when a company adopts or drops a platform. Migrating stacks means budget is moving in that category right now.",
    romaniaOnly: false,
  },
  {
    key: "pricing_page",
    label: "Pricing page changes",
    description:
      "Flags when a company changes its pricing or packaging — often the run-up to a bigger push.",
    romaniaOnly: false,
  },
];
