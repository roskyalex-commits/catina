import { NextResponse } from "next/server";
import { z } from "zod";
import { isDatabaseConfigured } from "@/lib/env";
import { getSessionContext } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/leads/[id] — record the user's verdict on one lead.
 *
 * Written for the onboarding preview, where rejecting a lead is what teaches
 * the ICP, but it is the same operation as the FIT column on the Contacts
 * table and there is no reason for two routes.
 *
 * **The caller's own session, no service role.** `leads` is a tenant table, so
 * RLS is what decides whether this row may be touched at all — a foreign lead
 * id comes back as missing, which is the correct answer to give and the one
 * that leaks nothing. Every column written here already exists; this route adds
 * no schema.
 *
 * `fit_feedback` is deliberately separate from `status`. "Bad fit" and
 * "rejected" are not the same claim: a lead can be a perfect fit and still be
 * skipped this quarter, and collapsing the two would poison the only explicit
 * training signal the product collects.
 */

const patchSchema = z
  .object({
    fitFeedback: z.enum(["good", "unsure", "bad"]).nullable().optional(),
    status: z.enum(["new", "approved", "rejected"]).optional(),
    rejectedReason: z.string().trim().max(200).nullable().optional(),
  })
  // An empty body is a client bug, not a no-op worth writing.
  .refine((body) => Object.keys(body).length > 0, {
    message: "Nothing to update.",
  });

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

  let input: z.infer<typeof patchSchema>;
  try {
    input = patchSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Some fields need fixing.",
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

  // Only the keys the caller actually sent. Spreading the parsed object whole
  // would write nulls over columns they never mentioned.
  const update: Record<string, unknown> = {};
  if ("fitFeedback" in input) update.fit_feedback = input.fitFeedback;
  if ("status" in input) update.status = input.status;
  if ("rejectedReason" in input) update.rejected_reason = input.rejectedReason;
  update.updated_at = new Date().toISOString();

  const { data, error } = await session.supabase
    .from("leads")
    .update(update)
    .eq("id", id)
    .select("id, status, fit_feedback, rejected_reason")
    .maybeSingle();

  if (error) {
    console.error("Updating the lead failed", { error });
    return NextResponse.json({ error: "Could not save that." }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "No such lead." }, { status: 404 });
  }

  const row = data as Record<string, unknown>;
  return NextResponse.json({
    lead: {
      id: String(row.id),
      status: row.status,
      fitFeedback: row.fit_feedback ?? null,
      rejectedReason: row.rejected_reason ?? null,
    },
  });
}
