import { NextResponse } from "next/server";
import { z } from "zod";
import { agentInsertFrom, agentSummaryFrom } from "@/lib/agents/mapper";
import { createAgentSchema } from "@/lib/agents/schema";
import { PLANS } from "@/lib/billing/limits";
import { isDatabaseConfigured } from "@/lib/env";
import { getSessionContext } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * /api/v1/agents — create and list the caller's agents.
 *
 * Goes through `getSessionContext()`, which returns the **request-scoped**
 * client carrying the user's JWT, so every query here is subject to RLS. The
 * service-role client must never appear on this path: it bypasses tenancy
 * entirely, and a bug in the org lookup below would then read another
 * workspace's agents rather than returning nothing.
 *
 * Validation is Zod at the boundary (`createAgentSchema`), and `org_id` is
 * taken from the caller's membership, never from the body.
 */

/** Columns the view models need. Explicit so a schema change fails loudly. */
// One line, not a concatenation: supabase-js reads this literal at the type
// level to shape the result, and `"a" + "b"` widens to `string`.
const AGENT_COLUMNS =
  "id, name, status, countries, keywords, caen_codes, target_titles, enabled_signals, next_launch_at, created_at";

/**
 * With no Supabase env the app runs on the demo dataset, and
 * `createSupabaseServerClient()` throws rather than returning a client. Say so
 * plainly instead of surfacing a 500 — this is the state a fresh clone is in,
 * so it is the response a first-time reader is most likely to see.
 *
 * `isDatabaseConfigured()` rather than `isDemoMode()`: same answer, without
 * pulling the demo dataset and the scoring engine into this route's bundle. It
 * asks only whether Supabase is set up — an unrelated missing key must not make
 * this route claim there is no database.
 */
function demoMode(): boolean {
  return !isDatabaseConfigured();
}

function notConfigured() {
  return NextResponse.json(
    {
      error:
        "This needs the database. Create the Supabase project, then run npm run db:setup.",
      code: "not_configured",
    },
    { status: 503 },
  );
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
}

function noWorkspace() {
  return NextResponse.json(
    { error: "Your workspace is not set up yet. Reload to finish signing in." },
    { status: 409 },
  );
}

export async function GET() {
  if (demoMode()) return notConfigured();

  try {
    const session = await getSessionContext();
    if (!session) return unauthorized();
    if (!session.orgId) return noWorkspace();

    const { data, error } = await session.supabase
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Listing agents failed", { orgId: session.orgId, error });
      return NextResponse.json(
        { error: "Could not load your agents. Try again in a moment." },
        { status: 500 },
      );
    }

    const agents = (data ?? []).map((row) =>
      agentSummaryFrom(row as Record<string, unknown>),
    );
    return NextResponse.json({ agents });
  } catch (error) {
    // An unreachable Supabase throws out of the client rather than returning
    // an error result. Without this the caller gets an HTML 500 and the
    // wizard can only say "something went wrong".
    console.error("Listing agents threw", { error });
    return NextResponse.json(
      { error: "Could not reach the database. Try again in a moment." },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  if (demoMode()) return notConfigured();

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
  if (!session) return unauthorized();
  if (!session.orgId) return noWorkspace();
  const orgId = session.orgId;

  let input;
  try {
    input = createAgentSchema.parse(await request.json());
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

  try {
    // Plan cap. Counted through the same RLS-scoped client, so it counts this
    // workspace's agents and no one else's.
    const { count, error: countError } = await session.supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    if (countError) {
      console.error("Counting agents failed", { orgId, error: countError });
      return NextResponse.json(
        { error: "Could not save the agent. Try again in a moment." },
        { status: 500 },
      );
    }

    // TODO(billing): read the org's plan once subscriptions land. Free is the
    // correct assumption while every workspace is on it.
    const limit = PLANS.free.maxAgents;
    if ((count ?? 0) >= limit) {
      return NextResponse.json(
        {
          error:
            limit === 1
              ? "The free plan includes one agent. Upgrade to add another."
              : `The free plan includes ${limit} agents. Upgrade to add another.`,
          code: "plan_limit",
        },
        { status: 402 },
      );
    }

    const { data, error } = await session.supabase
      .from("agents")
      .insert(agentInsertFrom(input, orgId))
      .select(AGENT_COLUMNS)
      .single();

    if (error || !data) {
      console.error("Creating agent failed", { orgId, error });
      return NextResponse.json(
        { error: "Could not save the agent. Try again in a moment." },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { agent: agentSummaryFrom(data as Record<string, unknown>) },
      { status: 201 },
    );
  } catch (error) {
    console.error("Creating agent threw", { orgId, error });
    return NextResponse.json(
      { error: "Could not reach the database. Try again in a moment." },
      { status: 503 },
    );
  }
}
