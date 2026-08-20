/**
 * Gives existing agents an industry vocabulary, and optionally re-derives their
 * CAEN codes from it.
 *
 *   npm run backfill:industries -- --dry-run
 *   npm run backfill:industries                 # sets industry_keys only
 *   npm run backfill:industries -- --widen      # also clears the override
 *
 * Migration `0004` set `caen_codes_overridden = true` on every agent that had
 * codes, because those codes came from a language model rather than from an
 * industry choice and silently re-deriving would have changed what a working
 * agent targets. This is the other half: read those codes *back* into industry
 * keys so the new UI has something to show, and — only when asked — drop the
 * pin so the codes come from the nomenclator instead.
 *
 * `--widen` is opt-in and prints the diff either way. Widening is usually
 * strictly additive (a model's hand-written list is a subset of the derived
 * one), but "usually" is not "always": a model can emit a code from an
 * industry the user never meant, and re-deriving would drop it. The script
 * reports removals separately so that is a decision rather than a surprise.
 */
import { createClient } from "@supabase/supabase-js";
import { industriesForCode, industryByKey, naceCodesFor } from "../src/lib/icp/industries";
import { requireEnv } from "./load-env";

type Options = { dryRun: boolean; widen: boolean; agentId?: string };

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, widen: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--widen":
        options.widen = true;
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

type AgentRow = {
  id: string;
  name: string;
  industries: string[] | null;
  industry_keys: string[] | null;
  caen_codes: string[] | null;
  caen_codes_overridden: boolean;
};

/**
 * Industry keys implied by a code list.
 *
 * Reading codes backwards is lossy on purpose: a code that no industry claims
 * contributes nothing rather than inventing a key for itself. Those are
 * reported, because a code the catalogue does not cover is either a gap in the
 * catalogue or a code the model made up, and both are worth seeing.
 */
function keysFromCodes(codes: string[]): { keys: string[]; unmapped: string[] } {
  const keys: string[] = [];
  const unmapped: string[] = [];

  for (const code of codes) {
    const owners = industriesForCode(code);
    if (owners.length === 0) {
      unmapped.push(code);
      continue;
    }
    for (const key of owners) if (!keys.includes(key)) keys.push(key);
  }
  return { keys, unmapped };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let query = db
    .from("agents")
    .select("id, name, industries, industry_keys, caen_codes, caen_codes_overridden")
    .order("created_at", { ascending: true });
  if (options.agentId) query = query.eq("id", options.agentId);

  const { data, error } = await query;
  if (error) {
    console.error(`Could not read agents: ${error.message}`);
    process.exit(1);
  }

  const agents = (data ?? []) as AgentRow[];
  console.log(`${agents.length} agents\n`);

  for (const agent of agents) {
    const codes = agent.caen_codes ?? [];
    const existingKeys = (agent.industry_keys ?? []).filter((k) => industryByKey(k));
    const { keys: fromCodes, unmapped } = keysFromCodes(codes);

    const keys = [...new Set([...existingKeys, ...fromCodes])];
    const derived = naceCodesFor(keys);
    const added = derived.filter((code) => !codes.includes(code));
    const removed = codes.filter((code) => !derived.includes(code));

    console.log(`${agent.name}  (${agent.id.slice(0, 8)})`);
    console.log(
      `  industries : ${keys.map((k) => industryByKey(k)?.label ?? k).join(", ") || "none"}`,
    );
    console.log(`  codes now  : ${codes.length}${options.widen ? ` → ${derived.length}` : ""}`);
    if (unmapped.length > 0) {
      console.log(`  unmapped   : ${unmapped.join(", ")}  (no industry claims these)`);
    }
    if (options.widen) {
      if (added.length > 0) console.log(`  + ${added.join(", ")}`);
      if (removed.length > 0) {
        console.log(`  - ${removed.join(", ")}  <-- these stop being targeted`);
      }
    }

    if (options.dryRun) {
      console.log("");
      continue;
    }

    const update: Record<string, unknown> = { industry_keys: keys };
    if (options.widen) {
      update.caen_codes = derived;
      update.caen_codes_overridden = false;
    }

    const { error: writeError } = await db.from("agents").update(update).eq("id", agent.id);
    if (writeError) console.error(`  !! ${writeError.message}`);
    else console.log(`  written`);
    console.log("");
  }

  if (options.dryRun) console.log("Dry run — nothing was written.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
