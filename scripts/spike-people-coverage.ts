/**
 * Phase 2b — the free-API coverage spike.
 *
 *   npm run spike:people                    # default: 10 companies per market
 *   npm run spike:people -- --limit 25
 *   npm run spike:people -- --providers hunter,prospeo --markets ro
 *
 * This is the gate on whether we build a crawler. It answers two questions the
 * plan leaves open:
 *
 *   1. Does each vendor's free tier include API access at all? (Apollo's does
 *      not — API starts at the ~$745/mo Organization plan. Others are assumed
 *      to, on the strength of blog comparisons that are frequently stale.)
 *   2. Given a company domain, what share of companies yield at least one
 *      decision-maker matching the ICP?
 *
 * Decision rule from the plan: >=60% people-coverage across both test sets
 * means ship on the free APIs and skip the crawler entirely. Below that, build
 * the crawler for the specific gap the numbers expose.
 *
 * A note on sample size. The plan called for 100 companies per market. Free
 * tiers run 25-75 lookups/month, so a 200-company run would exhaust every
 * quota partway through and report a coverage number that is really a
 * rate-limit artefact — a false negative that argues for building a crawler we
 * may not need. The default is therefore 10 per market, quota is probed before
 * any spend, and the run refuses to start a provider it cannot finish.
 * Raise --limit deliberately once you know the allowances.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import "dotenv/config";
import type { Icp } from "../src/lib/icp/schema";
import { isDecisionMaker } from "../src/lib/sources/people/seniority";
import { allPeopleProviders } from "../src/lib/sources/people/registry";
import type {
  FoundPerson,
  PeopleProvider,
  ProbeResult,
} from "../src/lib/sources/people/types";

/** Threshold from the plan. At or above this, the crawler is not built. */
const COVERAGE_THRESHOLD = 0.6;

/**
 * Test sets are real, currently-trading companies with public websites, spread
 * across company size and sector so the result is not an artefact of one
 * niche. Romanian set leans SMB and mid-market because that is the segment the
 * product targets and the one international vendors cover worst.
 */
const TEST_SETS: Record<string, { domain: string; name: string }[]> = {
  ro: [
    { domain: "emag.ro", name: "eMAG" },
    { domain: "dedeman.ro", name: "Dedeman" },
    { domain: "uipath.com", name: "UiPath" },
    { domain: "bitdefender.com", name: "Bitdefender" },
    { domain: "banca-transilvania.ro", name: "Banca Transilvania" },
    { domain: "altex.ro", name: "Altex" },
    { domain: "fancourier.ro", name: "FAN Courier" },
    { domain: "smartbill.ro", name: "SmartBill" },
    { domain: "gomag.ro", name: "Gomag" },
    { domain: "regina-maria.ro", name: "Regina Maria" },
    { domain: "profi.ro", name: "Profi" },
    { domain: "digi-communications.ro", name: "Digi Communications" },
    { domain: "therebels.ro", name: "The Rebels (agency)" },
    { domain: "vola.ro", name: "Vola.ro" },
    { domain: "elefant.ro", name: "Elefant" },
  ],
  intl: [
    { domain: "stripe.com", name: "Stripe" },
    { domain: "figma.com", name: "Figma" },
    { domain: "linear.app", name: "Linear" },
    { domain: "hubspot.com", name: "HubSpot" },
    { domain: "monzo.com", name: "Monzo" },
    { domain: "personio.com", name: "Personio" },
    { domain: "pipedrive.com", name: "Pipedrive" },
    { domain: "typeform.com", name: "Typeform" },
    { domain: "hotjar.com", name: "Hotjar" },
    { domain: "mews.com", name: "Mews" },
    { domain: "gitlab.com", name: "GitLab" },
    { domain: "doist.com", name: "Doist" },
    { domain: "remote.com", name: "Remote" },
    { domain: "contentful.com", name: "Contentful" },
    { domain: "algolia.com", name: "Algolia" },
  ],
};

/**
 * A deliberately broad ICP. The spike measures whether providers return
 * *anyone* worth contacting, not how well they hit one narrow persona —
 * a tight ICP would conflate provider coverage with targeting precision.
 */
const SPIKE_ICP: Pick<Icp, "targetTitles" | "targetSeniorities"> = {
  targetTitles: [
    "CEO",
    "Founder",
    "CTO",
    "CMO",
    "Marketing Director",
    "Head of Sales",
    "Director General",
    "Director de Marketing",
    "Director Comercial",
  ],
  targetSeniorities: ["founder", "c_level", "vp", "director", "head"],
};

type CompanyOutcome = {
  domain: string;
  name: string;
  peopleFound: number;
  decisionMakers: number;
  withEmail: number;
  error?: string;
};

type ProviderOutcome = {
  provider: string;
  label: string;
  freeTierNote: string;
  probe: ProbeResult;
  perMarket: Record<
    string,
    {
      companies: CompanyOutcome[];
      coverage: number;
      emailCoverage: number;
      avgDecisionMakers: number;
    }
  >;
  skipped?: string;
};

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, "true");
    }
  }
  return {
    limit: Number(args.get("limit") ?? 10),
    markets: (args.get("markets") ?? "ro,intl").split(",").map((m) => m.trim()),
    providers: args.get("providers")?.split(",").map((p) => p.trim()),
    perCompany: Number(args.get("per-company") ?? 10),
    out: args.get("out") ?? "docs/spike-results.md",
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

async function runCompany(
  provider: PeopleProvider,
  company: { domain: string; name: string },
  perCompany: number,
): Promise<CompanyOutcome> {
  try {
    const people: FoundPerson[] = await provider.findPeople({
      domain: company.domain,
      companyName: company.name,
      limit: perCompany,
    });

    return {
      ...company,
      peopleFound: people.length,
      decisionMakers: people.filter((p) => isDecisionMaker(p.title, SPIKE_ICP))
        .length,
      withEmail: people.filter((p) => p.email).length,
    };
  } catch (error) {
    return {
      ...company,
      peopleFound: 0,
      decisionMakers: 0,
      withEmail: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Refuses to start a provider whose remaining quota cannot cover the run.
 * A half-finished sweep reports a coverage figure that is really an
 * exhausted-credits figure, which is exactly the false negative this spike
 * must not produce.
 */
function quotaShortfall(
  probe: ProbeResult,
  callsNeeded: number,
): string | undefined {
  const remaining = probe.quota?.remaining;
  if (typeof remaining !== "number") return undefined;
  if (remaining >= callsNeeded) return undefined;
  return (
    `needs ${callsNeeded} calls but only ${remaining} ${probe.quota?.unit ?? "credits"} remain — ` +
    `lower --limit to ${Math.floor(remaining / 2)} or wait for the quota to reset`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const markets = opts.markets.filter((m) => TEST_SETS[m]);

  if (markets.length === 0) {
    console.error(`No valid markets. Choose from: ${Object.keys(TEST_SETS).join(", ")}`);
    process.exit(1);
  }

  let providers = allPeopleProviders({
    HUNTER_API_KEY: process.env.HUNTER_API_KEY,
    PROSPEO_API_KEY: process.env.PROSPEO_API_KEY,
    PDL_API_KEY: process.env.PDL_API_KEY,
    APIFY_TOKEN: process.env.APIFY_TOKEN,
    APIFY_PEOPLE_ACTOR: process.env.APIFY_PEOPLE_ACTOR,
  });
  if (opts.providers) {
    providers = providers.filter((p) => opts.providers!.includes(p.key));
  }

  const perMarketCount = Math.min(opts.limit, Math.min(...markets.map((m) => TEST_SETS[m].length)));
  const totalCalls = perMarketCount * markets.length;

  console.log("Phase 2b — free-API people-coverage spike");
  console.log(`Markets: ${markets.join(", ")} · ${perMarketCount} companies each`);
  console.log(`Budget: ${totalCalls} lookups per provider\n`);

  const outcomes: ProviderOutcome[] = [];

  for (const provider of providers) {
    console.log(`--- ${provider.label} (${provider.key}) ---`);
    const probe = await provider.probe();

    const outcome: ProviderOutcome = {
      provider: provider.key,
      label: provider.label,
      freeTierNote: provider.freeTierNote,
      probe,
      perMarket: {},
    };

    if (!probe.configured) {
      outcome.skipped = "no API key configured";
      console.log("  skipped — no API key configured\n");
      outcomes.push(outcome);
      continue;
    }

    if (!probe.apiAccessible) {
      // This is the Apollo-shaped finding: a free plan that has no API.
      outcome.skipped = `API not accessible: ${probe.error ?? "unknown reason"}`;
      console.log(`  API NOT ACCESSIBLE — ${probe.error ?? "unknown reason"}\n`);
      outcomes.push(outcome);
      continue;
    }

    console.log(
      `  api ok · plan ${probe.planName ?? "?"} · ` +
        `quota ${probe.quota?.remaining ?? "?"}/${probe.quota?.limit ?? "?"} ${probe.quota?.unit ?? ""}`,
    );

    const shortfall = quotaShortfall(probe, totalCalls);
    if (shortfall) {
      outcome.skipped = `insufficient quota: ${shortfall}`;
      console.log(`  SKIPPED — ${shortfall}\n`);
      outcomes.push(outcome);
      continue;
    }

    for (const market of markets) {
      const companies = TEST_SETS[market].slice(0, perMarketCount);
      const results: CompanyOutcome[] = [];

      for (const company of companies) {
        const result = await runCompany(provider, company, opts.perCompany);
        results.push(result);
        const flag = result.error
          ? `error: ${result.error.slice(0, 70)}`
          : `${result.peopleFound} people, ${result.decisionMakers} DM, ${result.withEmail} email`;
        console.log(`    ${market}/${company.domain.padEnd(26)} ${flag}`);
      }

      const withDm = results.filter((r) => r.decisionMakers > 0).length;
      const withEmail = results.filter((r) => r.withEmail > 0).length;

      outcome.perMarket[market] = {
        companies: results,
        coverage: withDm / results.length,
        emailCoverage: withEmail / results.length,
        avgDecisionMakers:
          results.reduce((sum, r) => sum + r.decisionMakers, 0) / results.length,
      };

      console.log(
        `  ${market}: coverage ${pct(withDm / results.length)} · ` +
          `with email ${pct(withEmail / results.length)}\n`,
      );
    }

    outcomes.push(outcome);
  }

  const report = buildReport(outcomes, markets, perMarketCount);
  // resolve(), not join() — --out may be an absolute path, and join() would
  // silently nest it under cwd and report a location the file is not at.
  const outPath = resolve(process.cwd(), opts.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, report, "utf8");

  console.log(verdict(outcomes, markets));
  console.log(`\nResults written to ${outPath}\n`);
}

/** The per-market coverage of the strongest provider that actually ran. */
function bestCoverage(outcomes: ProviderOutcome[], market: string): number {
  const ran = outcomes.filter((o) => !o.skipped && o.perMarket[market]);
  if (ran.length === 0) return 0;
  return Math.max(...ran.map((o) => o.perMarket[market].coverage));
}

function verdict(outcomes: ProviderOutcome[], markets: string[]): string {
  const ran = outcomes.filter((o) => !o.skipped);
  if (ran.length === 0) {
    return (
      "\nVERDICT: inconclusive — no provider ran.\n" +
      "Configure at least one key and re-run before deciding on the crawler."
    );
  }

  const lines = markets.map(
    (m) => `  ${m}: best coverage ${pct(bestCoverage(outcomes, m))}`,
  );
  const weakest = Math.min(...markets.map((m) => bestCoverage(outcomes, m)));

  // Gate on the weakest market, not the average: a crawler is built to close a
  // specific gap, and an average hides which market has one.
  const decision =
    weakest >= COVERAGE_THRESHOLD
      ? `SHIP ON FREE APIS — every market clears ${pct(COVERAGE_THRESHOLD)}. Skip Phase 2c.`
      : `BUILD THE CRAWLER for the markets below ${pct(COVERAGE_THRESHOLD)}, ` +
        `scoped to exactly that gap.`;

  return `\nVERDICT\n${lines.join("\n")}\n\n  ${decision}`;
}

function buildReport(
  outcomes: ProviderOutcome[],
  markets: string[],
  perMarketCount: number,
): string {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const lines: string[] = [
    "# Phase 2b — free-API coverage spike results",
    "",
    `Generated ${now} UTC by \`npm run spike:people\`.`,
    "",
    `Sample: ${perMarketCount} companies per market (${markets.join(", ")}).`,
    `Decision threshold: **${pct(COVERAGE_THRESHOLD)}** of companies yielding at least`,
    "one ICP-matching decision-maker. At or above it, ship on the free APIs and",
    "skip the crawler (Phase 2c); below it, build the crawler scoped to the gap.",
    "",
    "## API entitlement",
    "",
    "The first question: does the free tier include API access at all?",
    "",
    "| Provider | Configured | API accessible | Plan | Quota | Note |",
    "|---|---|---|---|---|---|",
  ];

  for (const o of outcomes) {
    const q = o.probe.quota;
    const quota = q
      ? `${q.remaining ?? "?"}/${q.limit ?? "?"} ${q.unit ?? ""}`.trim()
      : "—";
    lines.push(
      `| ${o.label} | ${o.probe.configured ? "yes" : "no"} | ` +
        `${o.probe.apiAccessible ? "yes" : "**no**"} | ${o.probe.planName ?? "—"} | ` +
        `${quota} | ${o.probe.error ? o.probe.error.slice(0, 90) : o.freeTierNote} |`,
    );
  }

  lines.push(
    "",
    "| Provider | API accessible | Note |",
    "|---|---|---|",
    "| Apollo.io | **no** | Free and Basic plans include no API access; API starts at the ~$745/mo Organization tier (5-seat minimum). Not implemented — nothing to test on a free tier. |",
    "",
    "## Coverage",
    "",
    "| Provider | Market | Coverage | With email | Avg DMs/company |",
    "|---|---|---|---|---|",
  );

  for (const o of outcomes) {
    if (o.skipped) {
      lines.push(`| ${o.label} | — | _skipped: ${o.skipped}_ | | |`);
      continue;
    }
    for (const market of markets) {
      const m = o.perMarket[market];
      if (!m) continue;
      lines.push(
        `| ${o.label} | ${market} | ${pct(m.coverage)} | ${pct(m.emailCoverage)} | ` +
          `${m.avgDecisionMakers.toFixed(1)} |`,
      );
    }
  }

  lines.push("", "## Verdict", "", "```", verdict(outcomes, markets).trim(), "```", "");
  lines.push("## Per-company detail", "");

  for (const o of outcomes) {
    if (o.skipped) continue;
    lines.push(`### ${o.label}`, "");
    for (const market of markets) {
      const m = o.perMarket[market];
      if (!m) continue;
      lines.push(`**${market}**`, "");
      lines.push("| Company | People | Decision-makers | With email | Error |");
      lines.push("|---|---|---|---|---|");
      for (const c of m.companies) {
        lines.push(
          `| ${c.name} (${c.domain}) | ${c.peopleFound} | ${c.decisionMakers} | ` +
            `${c.withEmail} | ${c.error ? c.error.slice(0, 80) : ""} |`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

main().catch((error) => {
  console.error("spike crashed:", error);
  process.exit(1);
});
