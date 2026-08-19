import { NextResponse } from "next/server";
import {
  buildWaterfall,
  enrichLead,
  enrichableLeadFrom,
  knownRoleEmailsFor,
  saveEnrichment,
  ENRICHABLE_LEAD_COLUMNS,
} from "@/lib/enrichment/enrich-lead";
import { isDatabaseConfigured } from "@/lib/env";
import { createSupabaseAdminClient, getSessionContext } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/leads/[id]/enrich — find an email address for one lead.
 *
 * Two clients, deliberately. The lead is read and written through the caller's
 * own session so RLS decides whether they may touch it — a foreign lead id
 * reads as missing, which is the correct answer to give. The service role is
 * used for exactly two things it is needed for: `emails`, which is shared
 * reference data with no `org_id` and is service-role-write by policy, and
 * `provider_usage`, which denies all user access and without which every
 * metered provider would look unmetered.
 *
 * Synchronous like the sourcing run, and for the same reason: one lead per
 * call, so a failure costs one lookup rather than a queued job nobody can see.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      {
        error:
          "Enrichment needs the database. Create the Supabase project, then run npm run db:setup.",
        code: "not_configured",
      },
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
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  if (!session.orgId) {
    return NextResponse.json(
      { error: "Your workspace is not set up yet. Reload to finish signing in." },
      { status: 409 },
    );
  }
  const { supabase, orgId } = session;

  try {
    const { data, error } = await supabase
      .from("leads")
      .select(ENRICHABLE_LEAD_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: "No such lead." }, { status: 404 });
    }

    const admin = createSupabaseAdminClient();
    const lead = enrichableLeadFrom(data as Record<string, unknown>);

    // A role address already harvested for this company answers the question
    // without a fetch. `emails` is shared reference data, so this is likely to
    // hit even the first time a given user clicks Enrich on a given company.
    const known = lead.companyId
      ? await knownRoleEmailsFor(admin, [lead.companyId])
      : new Map<string, string[]>();

    // Asking from the UI is an explicit instruction, so a previous empty result
    // does not stand in the way. The bulk script is the one that must not
    // re-spend, and it leaves `force` off.
    const outcome = await enrichLead(
      { waterfall: buildWaterfall(admin, orgId) },
      { ...lead, knownRoleEmails: known.get(lead.companyId ?? "") },
      { force: true },
    );

    const saved = await saveEnrichment({ admin, scoped: supabase }, lead, outcome);
    if (saved.error) throw new Error(saved.error);

    return NextResponse.json({
      leadId: outcome.leadId,
      email: outcome.email
        ? {
            address: outcome.email.address,
            status: outcome.email.status,
            confidence: outcome.email.confidence,
            isRoleAddress: outcome.email.isRoleAddress,
            provider: outcome.email.provider,
          }
        : null,
      score: { before: outcome.scoreBefore, after: outcome.scoreAfter },
      // The audit trail is the point: a user who gets no address is owed the
      // reason, and "no domain on file" is a different problem from "the
      // domain accepts no mail".
      attempts: outcome.attempts,
      alternatives: outcome.alternatives.map((alternative) => ({
        address: alternative.address,
        status: alternative.status,
        confidence: alternative.confidence,
      })),
      skipped: outcome.skipped ?? null,
    });
  } catch (error) {
    console.error(
      "Enrichment failed",
      id,
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Enrichment failed. Try again in a moment." },
      { status: 500 },
    );
  }
}
