import {
  agentDetailFrom,
  agentSummaryFrom,
} from "@/lib/agents/mapper";
import { getSessionContext } from "@/lib/supabase/server";
import { demoDataset, isDemoMode } from "./demo";
import type { AgentDetail, AgentSummary } from "./types";

/**
 * Agent accessors.
 *
 * Same seam as every other file in this directory: pages call these and touch
 * nothing else. Demo mode still short-circuits first, so the app keeps working
 * with no configuration at all.
 *
 * Reads go through the request-scoped Supabase client, so RLS decides what
 * comes back. A page that renders for the wrong tenant is a data leak, and
 * that boundary belongs in the database rather than in a `.eq("org_id", …)`
 * that someone can forget to write.
 */

// One line, not a concatenation: supabase-js reads this literal at the type
// level to shape the result, and `"a" + "b"` widens to `string`.
const AGENT_COLUMNS =
  "id, name, status, countries, keywords, caen_codes, target_titles, enabled_signals, next_launch_at, created_at";

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
    console.error("Listing agents failed", { error });
    return [];
  }

  return (data ?? []).map((row) =>
    agentSummaryFrom(row as Record<string, unknown>),
  );
}

export async function getAgent(id: string): Promise<AgentDetail | null> {
  if (isDemoMode()) {
    return demoDataset().agents.find((agent) => agent.id === id) ?? null;
  }

  const session = await getSessionContext();
  if (!session?.orgId) return null;

  const { data, error } = await session.supabase
    .from("agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("Loading agent failed", { id, error });
    return null;
  }
  if (!data) return null;

  // Counts stay zero until the sourcing run writes leads (step 4 in
  // docs/STATUS.md). They are an argument to the mapper rather than a
  // hard-coded zero so wiring them up later is one query, not a rewrite.
  return agentDetailFrom(data as Record<string, unknown>);
}
