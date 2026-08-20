import {
  agentDetailFrom,
  agentSummaryFrom,
  type AgentCounts,
} from "@/lib/agents/mapper";
import { getSessionContext } from "@/lib/supabase/server";
import { optionalString } from "@/lib/supabase/row";
import { LEAD_COLUMNS } from "./contacts";
import { demoDataset, isDemoMode } from "./demo";
import { activityEventFrom, contactRowFrom } from "./rows";
import type { AgentDetail, AgentSummary } from "./types";

/**
 * Agent accessors.
 *
 * Same seam as every other file in this directory: pages call these and touch
 * nothing else. Demo mode still short-circuits first, so the app keeps working
 * with no configuration at all.
 *
 * Reads go through the request-scoped Supabase client, so RLS decides what
 * comes back. A page that renders for the wrong tenant is a data leak, and that
 * boundary belongs in the database rather than in a `.eq("org_id", …)` that
 * someone can forget to write.
 */

// One line, not a concatenation: supabase-js reads this literal at the type
// level to shape the result, and `"a" + "b"` widens to `string`.
const AGENT_COLUMNS =
  "id, name, status, countries, keywords, industries, industry_keys, caen_codes, competitor_tech, competitor_names, target_titles, enabled_signals, next_launch_at, created_at";

/**
 * Lead counts per agent.
 *
 * One grouped read rather than two per agent: the list page renders every
 * agent, and a query per card is how a page acquires an N+1.
 */
async function countsByAgent(
  supabase: Awaited<ReturnType<typeof getSessionContext>> extends null
    ? never
    : NonNullable<Awaited<ReturnType<typeof getSessionContext>>>["supabase"],
  orgId: string,
): Promise<Map<string, AgentCounts>> {
  const counts = new Map<string, AgentCounts>();
  const { data, error } = await supabase
    .from("leads")
    .select("agent_id, status")
    .eq("org_id", orgId)
    .limit(10000);

  if (error) {
    console.error("Counting leads failed:", error.message);
    return counts;
  }

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const agentId = optionalString(row.agent_id);
    if (!agentId) continue;
    const entry = counts.get(agentId) ?? { leadsFound: 0, contacted: 0 };
    entry.leadsFound += 1;
    // "Contacted" means a message actually left, not that we intend to send.
    if (["queued", "sent", "replied"].includes(optionalString(row.status) ?? "")) {
      entry.contacted += 1;
    }
    counts.set(agentId, entry);
  }
  return counts;
}

export async function listAgents(): Promise<AgentSummary[]> {
  if (isDemoMode()) return demoDataset().agents;

  const session = await getSessionContext();
  if (!session?.orgId) return [];

  const { data, error } = await session.supabase
    .from("agents")
    .select(AGENT_COLUMNS)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Listing agents failed:", error.message);
    return [];
  }

  const counts = await countsByAgent(session.supabase, session.orgId);
  return (data ?? []).map((row) => {
    const agent = row as Record<string, unknown>;
    return agentSummaryFrom(agent, counts.get(String(agent.id)));
  });
}

export async function getAgent(id: string): Promise<AgentDetail | null> {
  if (isDemoMode()) {
    return demoDataset().agents.find((agent) => agent.id === id) ?? null;
  }

  const session = await getSessionContext();
  if (!session?.orgId) return null;
  const { supabase, orgId } = session;

  const { data, error } = await supabase
    .from("agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("Loading agent failed:", id, error.message);
    return null;
  }
  if (!data) return null;

  const [leadRows, runRows, counts] = await Promise.all([
    supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("org_id", orgId)
      .eq("agent_id", id)
      .order("score", { ascending: false })
      .limit(100),
    supabase
      .from("job_runs")
      .select("id, kind, status, title, subtitle, leads_found, created_at")
      .eq("org_id", orgId)
      .eq("agent_id", id)
      .order("created_at", { ascending: false })
      .limit(25),
    countsByAgent(supabase, orgId),
  ]);

  const detail = agentDetailFrom(data as Record<string, unknown>, counts.get(id));

  detail.leads = (leadRows.data ?? []).map((row) =>
    contactRowFrom(row as Record<string, unknown>),
  );
  detail.activity = (runRows.data ?? []).map((row) =>
    activityEventFrom(row as Record<string, unknown>),
  );
  detail.stats = {
    ...detail.stats,
    found: detail.leads.length,
  };

  // The queue stays empty until drafting exists — an agent that has sourced
  // leads has not thereby written anything to send.
  detail.queue = [];

  return detail;
}
