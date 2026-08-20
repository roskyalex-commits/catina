/**
 * Frees or fills the free plan's single agent slot.
 *
 *   npm run agent:toggle -- "Cluj software" off
 *   npm run agent:toggle -- "SmartBill" on
 *
 * The free plan allows one *active* agent, counted on `is_active`, so a second
 * one 402s — including the draft the onboarding preview creates. Rather than
 * exempting drafts from the cap or deleting an agent to make room, this flips
 * the flag: `is_active = false` hides an agent from the list and the count
 * while its leads, signals and emails all stay exactly where they are.
 *
 * Development only, and reversible in both directions. It is not a substitute
 * for a real plan upgrade — it is how you look at two agents' worth of work on
 * a one-agent plan.
 */
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const [name, state] = process.argv.slice(2);
  if (!name || (state !== "on" && state !== "off")) {
    console.error('Usage: npm run agent:toggle -- "<agent name>" <on|off>');
    process.exit(1);
  }

  const { data, error } = await db
    .from("agents")
    .update({ is_active: state === "on" })
    .eq("name", name)
    .select("id, name, status, is_active");
  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as { name: string; status: string; is_active: boolean }[];
  if (rows.length === 0) {
    console.error(`No agent named "${name}".`);
    process.exit(1);
  }
  for (const row of rows) {
    console.log(`${row.name}: is_active=${row.is_active} (status ${row.status})`);
  }

  // Say the count out loud: the whole point is which agents fill the one slot.
  const { count } = await db
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  console.log(`${count} active agent(s) — the free plan allows 1.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
