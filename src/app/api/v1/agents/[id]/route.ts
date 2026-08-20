import { NextResponse } from "next/server";
import { z } from "zod";
import { agentInsertFrom, agentSummaryFrom } from "@/lib/agents/mapper";
import { createAgentSchema } from "@/lib/agents/schema";
import { isDatabaseConfigured } from "@/lib/env";
import { normaliseIcpIndustries } from "@/lib/icp/normalise-industries";
import { getSessionContext } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/agents/[id] — replace an agent's targeting.
 *
 * The onboarding preview is what needs this. Each refinement the user accepts
 * changes the ICP, and the next preview run has to source against the new one —
 * but the free plan allows a single agent, so creating a second draft would
 * 402 on the first re-run. Updating the draft in place is the fix. Exempting
 * drafts from the plan cap would not be: a draft that sources real leads costs
 * exactly what a live agent costs.
 *
 * A **whole-object replace**, not a partial merge. The wizard holds the entire
 * ICP in memory and is the only caller; accepting arbitrary subsets would mean
 * two representations of an agent's targeting that can disagree. The same
 * `createAgentSchema` validates both routes for the same reason.
 *
 * The caller's own session throughout — `agents` is a tenant table, so RLS
 * decides whether this row may be touched, and a foreign id reads as missing.
 */

const AGENT_COLUMNS =
  "id, name, status, countries, keywords, industries, industry_keys, caen_codes, competitor_tech, competitor_names, target_titles, enabled_signals, next_launch_at, created_at";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "This needs the database. Run npm run db:setup.", code: "not_configured" },
      { status: 503 },
    );
  }

  const { id } = await params;

  let session;
  try {
    session = await getSessionContext();
  } catch (error) {
    console.error("Resolving the session threw", { error });
    return NextResponse.json(
      { error: "Could not reach the database. Try again in a moment." },
      { status: 503 },
    );
  }
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  if (!session.orgId) {
    return NextResponse.json({ error: "No workspace yet." }, { status: 409 });
  }
  const orgId = session.orgId;

  let input;
  try {
    const parsed = createAgentSchema.parse(await request.json());
    // The same derivation boundary the create route uses. An agent updated
    // here must end up with codes derived exactly as one created there would.
    input = { ...parsed, ...normaliseIcpIndustries(parsed).icp };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Some fields need fixing before this can be saved.",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  /*
   * `agentInsertFrom` builds the row including `org_id` and `status: "draft"`.
   * Both are dropped here: org membership is not something an update may move,
   * and an agent that has already been launched must not be quietly demoted to
   * a draft by an edit.
   */
  const row = agentInsertFrom(input, orgId);
  delete row.org_id;
  delete row.status;
  const update = row;

  const { data, error } = await session.supabase
    .from("agents")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(AGENT_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error("Updating agent failed", { orgId, id, error });
    return NextResponse.json(
      { error: "Could not save the agent. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!data) return NextResponse.json({ error: "No such agent." }, { status: 404 });

  return NextResponse.json({
    agent: agentSummaryFrom(data as Record<string, unknown>),
  });
}
