/**
 * Drives the onboarding wizard's server side against a running app.
 *
 *   npm run dev            # other terminal
 *   npm run verify:onboarding
 *
 * The wizard's UI can be checked in a browser; what cannot is whether the four
 * routes behind it behave when a real session, real RLS and the real plan cap
 * are in play. Three of those only bite in situations that are awkward to reach
 * by clicking: the second preview run, a foreign workspace, and a lead id that
 * belongs to someone else.
 *
 * Everything happens in a throwaway workspace that is deleted at the end,
 * whether the run passes or not.
 */
import { createClient } from "@supabase/supabase-js";
import { naceCodesFor } from "../src/lib/icp/industries";
import { requireEnv } from "./load-env";

const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const APP = process.env.APP_URL ?? "http://localhost:3000";

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cleanup: (() => Promise<void>)[] = [];
let failures = 0;

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`[${ok ? "  ok  " : " FAIL "}] ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log("          ", JSON.stringify(detail).slice(0, 500));
  }
}

const MAX_CHUNK_SIZE = 3180;

/** Write the session the way @supabase/ssr does, so the route reads it. */
function sessionCookies(session: unknown): string {
  const ref = new URL(url).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  if (value.length <= MAX_CHUNK_SIZE) return `${name}=${value}`;
  const chunks: string[] = [];
  for (let i = 0; i * MAX_CHUNK_SIZE < value.length; i += 1) {
    chunks.push(`${name}.${i}=${value.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE)}`);
  }
  return chunks.join("; ");
}

async function call(
  method: string,
  path: string,
  session: unknown | null,
  body?: unknown,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers.cookie = sessionCookies(session);
  const response = await fetch(`${APP}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    /* status alone is the signal */
  }
  return { status: response.status, body: payload };
}

/** A workspace, its owner, and a live session for them. */
async function tenant(tag: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `onboarding-${tag}-${stamp}@example.test`;
  const password = `Test-${crypto.randomUUID()}`;

  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`createUser: ${userError?.message}`);

  const { data: org, error: orgError } = await admin
    .from("orgs")
    .insert({ name: `Onboarding ${tag}`, slug: `onboarding-${tag}-${stamp}` })
    .select("id")
    .single();
  if (orgError || !org) throw new Error(`orgs insert: ${orgError?.message}`);

  await admin
    .from("memberships")
    .insert({ org_id: org.id, user_id: user.user.id, role: "owner" });

  const auth = createClient(url, requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInError } = await auth.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signedIn.session) {
    throw new Error(`signIn: ${signInError?.message}`);
  }

  cleanup.push(async () => {
    await admin.from("leads").delete().eq("org_id", org.id);
    await admin.from("job_runs").delete().eq("org_id", org.id);
    await admin.from("agents").delete().eq("org_id", org.id);
    await admin.from("orgs").delete().eq("id", org.id);
    await admin.auth.admin.deleteUser(user.user!.id);
  });

  return { orgId: org.id as string, session: signedIn.session };
}

/** The body the wizard posts: an ICP plus a name, a site and the signal keys. */
function agentBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Onboarding preview",
    websiteUrl: "https://example.ro",
    valueProp: "We sell bookkeeping automation to Romanian software firms.",
    targetTitles: ["Director General"],
    targetSeniorities: ["c_level"],
    industries: [],
    industryKeys: ["software"],
    caenCodes: [],
    caenCodesOverridden: false,
    companyTypes: ["smb"],
    countries: ["RO"],
    keywords: ["software"],
    competitorTech: [],
    competitorNames: [],
    exclusions: [],
    employeeMin: null,
    employeeMax: null,
    revenueMinRon: null,
    revenueMaxRon: null,
    confidence: 0.8,
    assumptions: [],
    enabledSignals: ["keyword_site", "competitor_tech", "anaf_growth", "hiring"],
    ...overrides,
  };
}

async function main() {
  const a = await tenant("a");
  const b = await tenant("b");

  // --- creating the draft ---------------------------------------------------
  const created = await call("POST", "/api/v1/agents", a.session, agentBody());
  check("POST /agents creates the draft", created.status === 201, created.body);
  const agentId = (created.body.agent as { id?: string } | undefined)?.id;
  if (!agentId) {
    console.error("No agent id — the rest cannot run.");
    failures += 1;
    return;
  }

  const { data: stored } = await admin
    .from("agents")
    .select("caen_codes, industry_keys, enabled_signals, caen_codes_overridden")
    .eq("id", agentId)
    .single();
  const row = (stored ?? {}) as Record<string, unknown>;

  check(
    "industries derive the CAEN codes, both revisions",
    JSON.stringify((row.caen_codes as string[])?.slice().sort()) ===
      JSON.stringify(naceCodesFor(["software"])),
    row.caen_codes,
  );
  check(
    "the wizard's signal choice is persisted — no agent has ever had this set",
    (row.enabled_signals as string[])?.length === 4,
    row.enabled_signals,
  );
  check("codes are not marked overridden", row.caen_codes_overridden === false);

  // --- updating it, which is what makes a second preview possible -----------
  const patched = await call("PATCH", `/api/v1/agents/${agentId}`, a.session, {
    ...agentBody({ industryKeys: ["software", "healthcare"] }),
  });
  check("PATCH /agents/[id] updates targeting", patched.status === 200, patched.body);

  const { data: afterPatch } = await admin
    .from("agents")
    .select("caen_codes, industry_keys, status")
    .eq("id", agentId)
    .single();
  const patchedRow = (afterPatch ?? {}) as Record<string, unknown>;
  check(
    "the update re-derives codes rather than trusting the body",
    JSON.stringify((patchedRow.caen_codes as string[])?.slice().sort()) ===
      JSON.stringify(naceCodesFor(["software", "healthcare"])),
    patchedRow.caen_codes,
  );
  // An edit must not demote an agent that has already been launched.
  check("status is left alone by an update", patchedRow.status === "draft");

  check(
    "a second workspace cannot update it",
    (await call("PATCH", `/api/v1/agents/${agentId}`, b.session, agentBody())).status === 404,
  );

  // --- the preview runs twice, which is where the plan cap used to bite -----
  const first = await call("POST", "/api/v1/sourcing/run", a.session, {
    agentId,
    limit: 5,
  });
  check("first preview run succeeds", first.status === 200, first.body);

  const leads = (first.body.leads ?? []) as {
    id: string | null;
    company: string;
    caen: string | null;
    signals: unknown[];
  }[];
  check(
    "every preview lead carries the id its verdict needs",
    leads.length === 0 || leads.every((lead) => typeof lead.id === "string"),
    leads.slice(0, 2),
  );
  check(
    "and the company facts the card shows",
    leads.length === 0 || leads.every((lead) => "caen" in lead && Array.isArray(lead.signals)),
    leads.slice(0, 1),
  );

  const second = await call("POST", "/api/v1/sourcing/run", a.session, {
    agentId,
    limit: 5,
  });
  // The whole reason the wizard reuses one draft: creating a second agent for
  // the second preview would 402 against the free plan's one-agent cap.
  check("the second preview run also succeeds", second.status === 200, second.body);

  const secondCreate = await call("POST", "/api/v1/agents", a.session, agentBody());
  check(
    "a second agent is still refused, so drafts are not exempt from the cap",
    secondCreate.status === 402,
    secondCreate.body,
  );

  // --- recording a rejection ------------------------------------------------
  const leadId = leads.find((lead) => lead.id)?.id;
  if (!leadId) {
    console.log("\nNo leads were sourced, so the verdict checks were skipped.");
    console.log("That is a data problem, not a route problem — widen the agent's ICP.\n");
  } else {
    const rejected = await call("PATCH", `/api/v1/leads/${leadId}`, a.session, {
      fitFeedback: "bad",
      status: "rejected",
      rejectedReason: "Rejected during onboarding preview",
    });
    check("PATCH /leads/[id] records the verdict", rejected.status === 200, rejected.body);

    const { data: leadRow } = await admin
      .from("leads")
      .select("status, fit_feedback, rejected_reason, score")
      .eq("id", leadId)
      .single();
    const lead = (leadRow ?? {}) as Record<string, unknown>;
    check("fit_feedback is stored", lead.fit_feedback === "bad", lead);
    check("status is stored", lead.status === "rejected", lead);

    const partial = await call("PATCH", `/api/v1/leads/${leadId}`, a.session, {
      fitFeedback: "good",
    });
    check("a partial update touches only what it names", partial.status === 200, partial.body);
    const { data: afterPartial } = await admin
      .from("leads")
      .select("status, fit_feedback")
      .eq("id", leadId)
      .single();
    const partialRow = (afterPartial ?? {}) as Record<string, unknown>;
    check(
      "status survives an update that did not mention it",
      partialRow.status === "rejected" && partialRow.fit_feedback === "good",
      partialRow,
    );

    check(
      "a second workspace cannot touch the lead",
      (await call("PATCH", `/api/v1/leads/${leadId}`, b.session, { fitFeedback: "good" }))
        .status === 404,
    );
    check(
      "an anonymous caller cannot either",
      (await call("PATCH", `/api/v1/leads/${leadId}`, null, { fitFeedback: "good" })).status ===
        401,
    );
    check(
      "an empty body is rejected rather than written",
      (await call("PATCH", `/api/v1/leads/${leadId}`, a.session, {})).status === 400,
    );
  }

  check(
    "a missing lead reads as missing, not forbidden",
    (
      await call(
        "PATCH",
        "/api/v1/leads/00000000-0000-0000-0000-000000000000",
        a.session,
        { fitFeedback: "good" },
      )
    ).status === 404,
  );
}

main()
  .catch((error) => {
    failures += 1;
    console.error("\nThe run threw:", error instanceof Error ? error.message : error);
  })
  .finally(async () => {
    for (const undo of cleanup.reverse()) {
      await undo().catch((error) => console.error("cleanup:", error));
    }
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
