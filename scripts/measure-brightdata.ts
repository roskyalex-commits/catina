/**
 * Is Bright Data worth buying? Answered on the free credits, before paying.
 *
 *   npm run measure:brightdata -- --probe        # 1 name, dump the raw shape
 *   npm run measure:brightdata -- --limit 50     # the real measurement
 *
 * Every Bright Data account gets 5,000 Web Scraper API credits a month with no
 * card. A discovered profile costs roughly one, so this is free.
 *
 * ## The three numbers, in order
 *
 * **1. Is the person on LinkedIn at all?** Our people are administrators of
 * Romanian companies. Nobody knows what share of them have a profile, and if it
 * is low nothing else matters. This is the gate.
 *
 * **2. Can we tell it is the right person?** Discovery is by name, and names are
 * not unique. `current_company` is the only disambiguator, so a profile that
 * does not name a matching employer is unusable — see `match.ts` for why that
 * has to fail closed.
 *
 * **3. Does the title actually say anything?** The whole purchase is for job
 * roles. If LinkedIn also says "Administrator" — which is the honest title for
 * the owner of a Romanian SRL — then we would be paying to relabel a field that
 * is already correct. This is the number that decides, and it is the one nobody
 * would think to look at.
 *
 * ## Which leads it asks about
 *
 * The mid-market agent's, deliberately: companies with 20+ employees, where a
 * separate department head plausibly exists. Measuring on the older lead set
 * would be measuring the wrong population — 95% of those are sole traders,
 * where the administrator *is* the buyer and a LinkedIn title adds nothing.
 * That distinction is the whole reason this segment was built first.
 */
import { createClient } from "@supabase/supabase-js";
import { isGenericTitle } from "../src/lib/sources/people/repository";
import {
  BrightDataClient,
  BrightDataError,
  toProfile,
  type BrightDataProfile,
} from "../src/lib/sources/brightdata/client";
import { companyMatches } from "../src/lib/sources/brightdata/match";
import { requireEnv } from "./load-env";

const DEFAULT_LIMIT = 50;
/** The agent whose leads are worth asking about. */
const MID_MARKET_AGENT = "eaa9561f-54c7-44c7-aaa7-c204543c0a4f";

type Options = { limit: number; probe: boolean; agentId: string };

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: DEFAULT_LIMIT,
    probe: false,
    agentId: MID_MARKET_AGENT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--limit":
        options.limit = Number(next());
        break;
      case "--probe":
        options.probe = true;
        break;
      case "--agent":
        options.agentId = next();
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

const bright = new BrightDataClient(process.env.BRIGHTDATA_API_KEY);

type Target = {
  firstName: string;
  lastName: string;
  fullName: string;
  companyName: string;
  title: string | null;
};

async function loadTargets(options: Options): Promise<Target[]> {
  const { data, error } = await db
    .from("leads")
    .select("score, people(full_name, first_name, last_name, title), companies(name)")
    .eq("agent_id", options.agentId)
    .order("score", { ascending: false })
    .limit(options.limit * 2);

  if (error) throw new Error(`leads: ${error.message}`);

  const targets: Target[] = [];
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const person = embedded(record.people);
    const company = embedded(record.companies);
    const firstName = str(person?.first_name);
    const lastName = str(person?.last_name);
    const companyName = str(company?.name);

    // No resolved halves means no name to search and no way to match back.
    if (!firstName || !lastName || !companyName) continue;

    targets.push({
      firstName,
      lastName,
      fullName: str(person?.full_name) ?? `${firstName} ${lastName}`,
      companyName,
      title: str(person?.title) ?? null,
    });
    if (targets.length >= options.limit) break;
  }
  return targets;
}

/** PostgREST returns an embedded row as an object or a one-element array. */
function embedded(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return value[0] as Record<string, unknown> | undefined;
  return (value as Record<string, unknown>) ?? undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pct(part: number, total: number): string {
  if (total === 0) return "   0 (  0.0%)";
  return `${String(part).padStart(4)} (${((part / total) * 100).toFixed(1).padStart(5)}%)`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!bright.isConfigured()) {
    console.error(
      "BRIGHTDATA_API_KEY is not set.\n\n" +
        "  Create a free account at https://brightdata.com/ — no card, 5,000 Web\n" +
        "  Scraper API credits a month. Create an API key, then put it in\n" +
        "  .env.local as BRIGHTDATA_API_KEY.",
    );
    process.exit(1);
  }

  const targets = await loadTargets({ ...options, limit: options.probe ? 1 : options.limit });
  if (targets.length === 0) {
    console.error("No leads with a resolved first and last name. Run `npm run backfill:names`.");
    process.exit(1);
  }

  console.log(
    `Asking Bright Data about ${targets.length} people from the mid-market segment.\n` +
      `Discovery is by name; the employer is what tells us it is the right person.\n`,
  );

  let snapshotId: string;
  try {
    snapshotId = await bright.triggerNameDiscovery(targets);
  } catch (error) {
    console.error(
      `\nTrigger failed: ${error instanceof BrightDataError ? error.message : String(error)}\n\n` +
        `  If this is a 400, the discovery parameters differ from the documented\n` +
        `  ones. Check dataset_id, type=discover_new and discover_by=name against\n` +
        `  the current API reference before trusting anything this prints.`,
    );
    process.exit(1);
  }

  console.log(`snapshot ${snapshotId} — waiting…`);
  let rows: Record<string, unknown>[];
  try {
    rows = await bright.waitForSnapshot(snapshotId, (status, elapsed) => {
      process.stdout.write(`\r  ${status}, ${Math.round(elapsed / 1000)}s`);
    });
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`\n  ${rows.length} rows returned\n`);

  if (options.probe) {
    /*
     * Look at one raw row before trusting a tally. The response shape here is
     * coded from documentation, and a field-name mismatch would report 0%
     * matched — which reads exactly like "Romanian managers are not on
     * LinkedIn" and would kill the idea for the wrong reason.
     */
    console.log("raw first row:");
    console.log(JSON.stringify(rows[0] ?? null, null, 2).slice(0, 3000));
    console.log("\nparsed by our client:");
    console.log(JSON.stringify(toProfile(rows[0] ?? {}), null, 2).slice(0, 1200));
    return;
  }

  const profiles: BrightDataProfile[] = rows.map(toProfile);

  /*
   * Group by the name we asked about. Discovery can return several profiles for
   * one name — that is the ambiguity this whole measurement is about — so the
   * unit is the person we asked about, not the row that came back.
   */
  const byName = new Map<string, BrightDataProfile[]>();
  for (const profile of profiles) {
    const key = `${(profile.firstName ?? "").toLowerCase()} ${(profile.lastName ?? "").toLowerCase()}`.trim();
    byName.set(key, [...(byName.get(key) ?? []), profile]);
  }

  let anyProfile = 0;
  let matched = 0;
  let realTitle = 0;
  let ambiguous = 0;
  const titles: string[] = [];
  const samples: string[] = [];

  for (const target of targets) {
    const key = `${target.firstName.toLowerCase()} ${target.lastName.toLowerCase()}`;
    const candidates = byName.get(key) ?? [];
    if (candidates.length === 0) continue;
    anyProfile += 1;
    if (candidates.length > 1) ambiguous += 1;

    const hit = candidates.find(
      (candidate) => companyMatches(target.companyName, candidate.currentCompany).matched,
    );
    if (!hit) continue;
    matched += 1;

    if (hit.title && !isGenericTitle(hit.title)) {
      realTitle += 1;
      titles.push(hit.title);
    }
    if (samples.length < 12) {
      samples.push(
        `  ${target.fullName.slice(0, 24).padEnd(26)} ${(hit.title ?? "(no title)").slice(0, 30).padEnd(32)} ${target.companyName.slice(0, 26)}`,
      );
    }
  }

  console.log(`Asked about ${targets.length} people\n`);
  console.log(`  1. found on LinkedIn at all   ${pct(anyProfile, targets.length)}`);
  console.log(`     ...of those, ambiguous     ${pct(ambiguous, Math.max(anyProfile, 1))}`);
  console.log(`  2. employer confirms identity ${pct(matched, targets.length)}`);
  console.log(`  3. AND has a real job title   ${pct(realTitle, targets.length)}`);

  if (samples.length) {
    console.log(`\nMatched people and the title LinkedIn gives them:`);
    for (const sample of samples) console.log(sample);
  }

  console.log(`\n${"-".repeat(64)}`);

  /*
   * The verdict, in the terms the decision is actually made in. Number 3 is the
   * one that matters: everything else can be perfect and the purchase still be
   * pointless if LinkedIn agrees the person is an "Administrator".
   */
  const usable = targets.length ? realTitle / targets.length : 0;
  console.log(
    `\n${(usable * 100).toFixed(1)}% of the people asked about came back with a confirmed\n` +
      `identity AND a job title worth having. Across 864 mid-market leads that is\n` +
      `roughly ${Math.round(usable * 864)} leads whose targeting would improve.`,
  );

  if (anyProfile / targets.length < 0.2) {
    console.log(
      `\n  Fewer than one in five was found at all. That is a fact about Romanian\n` +
        `  SME managers and LinkedIn, not about Bright Data — no vendor can sell\n` +
        `  profiles that do not exist. Stop here.`,
    );
  } else if (usable < 0.15) {
    console.log(
      `\n  Below 15% this does not pay for itself. Check the titles above: if they\n` +
        `  read "Administrator" or "Owner", LinkedIn agrees with the register and\n` +
        `  there was nothing to buy.`,
    );
  }
}

main();
