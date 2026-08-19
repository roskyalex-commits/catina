/**
 * Verifies email enrichment against the running app and the live database.
 *
 *   npm run dev              # in another terminal
 *   npm run verify:emails
 *
 * Step 5a in docs/STATUS.md. The orchestration is unit-tested against fakes and
 * the bulk script has run for real, but `POST /api/v1/leads/[id]/enrich` had
 * never been driven — and it is the one path that crosses every boundary at
 * once: the caller's session for the lead, the service role for `emails`, RLS
 * deciding whether a foreign lead exists, and a re-run that must not duplicate.
 *
 * Three leads are planted in a throwaway workspace, chosen from real companies
 * so the assertions are about this schema and this data:
 *
 *   - one whose company has a harvested role address  → must resolve, must score up
 *   - one whose company has no domain at all          → must skip, must not invent one
 *   - one whose company has a domain but no address   → must record the miss
 *
 * The workspace is deleted at the end, pass or fail. `emails` rows are shared
 * reference data and are deliberately **not** deleted: they belong to the
 * company, not to the test tenant, and removing them would throw away a real
 * crawl result.
 */
import { createClient } from "@supabase/supabase-js";
import type { ScoreBreakdown } from "../src/lib/signals/scoring";
import { requireEnv } from "./load-env";

const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
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
    if (detail !== undefined) console.log("          ", JSON.stringify(detail).slice(0, 400));
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

async function call(path: string, session: unknown | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers.cookie = sessionCookies(session);
  const response = await fetch(`${APP}${path}`, { method: "POST", headers });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* status alone is the signal */
  }
  return { status: response.status, body };
}

/**
 * A lead as sourcing leaves it: good fit, no signals, no address.
 *
 * Written out rather than produced by a real sourcing run, because the number
 * that matters is the starting total — 45 is the no-email ceiling, and a test
 * that starts somewhere else cannot show it being lifted.
 */
function breakdownAt45(): ScoreBreakdown {
  return {
    total: 45,
    icpFit: { score: 1, weight: 0.45, reasons: [{ label: "Target title", points: 1 }] },
    signals: { score: 0, weight: 0.35, reasons: [] },
    contactability: {
      score: 0,
      weight: 0.2,
      reasons: [{ label: "No email address found", points: 0 }],
    },
    penalties: { total: 0, reasons: [] },
  };
}

type Company = { id: string; name: string; domain: string | null };

/** Pick the three companies the assertions need, from what is actually imported. */
async function pickCompanies() {
  const { data: harvested } = await admin
    .from("emails")
    .select("company_id, address")
    .eq("is_role_address", true)
    .not("company_id", "is", null)
    .limit(1);
  const withAddress = (harvested ?? [])[0] as
    | { company_id: string; address: string }
    | undefined;

  const withDomain = await admin
    .from("companies")
    .select("id, name, domain")
    .not("domain", "is", null)
    .limit(40);

  const noDomain = await admin
    .from("companies")
    .select("id, name, domain")
    .is("domain", null)
    .limit(1);

  const domainRows = ((withDomain.data ?? []) as Company[]).filter(
    (company) => company.id !== withAddress?.company_id,
  );

  return {
    withAddress,
    // A domain we have already crawled once without finding anything — the
    // "we looked and there was nothing" case, which must be recorded, not retried
    // forever.
    domainNoAddress: domainRows[0],
    noDomain: ((noDomain.data ?? []) as Company[])[0],
  };
}

async function main() {
  console.log(`Verifying enrichment against ${APP}\n`);
  try {
    await fetch(`${APP}/login`);
  } catch {
    console.error(`Cannot reach ${APP}. Start it with: npm run dev`);
    process.exit(1);
  }

  const picked = await pickCompanies();
  if (!picked.withAddress) {
    console.error(
      "No harvested role addresses to test against.\n" +
        "Run this first:  npm run enrich:emails -- --companies",
    );
    process.exit(1);
  }
  if (!picked.noDomain || !picked.domainNoAddress) {
    console.error("The registry is too small to test against. Run import:onrc first.");
    process.exit(1);
  }

  const { count: emailsBefore } = await admin
    .from("emails")
    .select("id", { count: "exact", head: true });
  console.log(`registry: ${emailsBefore} email rows before this run\n`);

  // --- a throwaway workspace -------------------------------------------------
  const stamp = Date.now();
  const email = `enrich-${stamp}@example.test`;
  const password = `Test-${crypto.randomUUID()}`;

  const { data: user } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const { data: org } = await admin
    .from("orgs")
    .insert({ name: "Enrichment test", slug: `enrich-${stamp}` })
    .select("id")
    .single();
  await admin
    .from("memberships")
    .insert({ org_id: org!.id, user_id: user.user!.id, role: "owner" });

  const { data: agent } = await admin
    .from("agents")
    .insert({
      org_id: org!.id,
      name: "Enrichment test",
      website_url: "https://example.ro",
      value_prop: "We sell bookkeeping automation to Romanian software firms.",
      countries: ["RO"],
    })
    .select("id")
    .single();

  cleanup.push(async () => {
    await admin.from("leads").delete().eq("org_id", org!.id);
    await admin.from("job_runs").delete().eq("org_id", org!.id);
    await admin.from("agents").delete().eq("org_id", org!.id);
    await admin.from("orgs").delete().eq("id", org!.id);
    await admin.auth.admin.deleteUser(user.user!.id);
  });

  async function plant(companyId: string) {
    const { data, error } = await admin
      .from("leads")
      .insert({
        org_id: org!.id,
        agent_id: agent!.id,
        company_id: companyId,
        score: 45,
        score_breakdown: breakdownAt45(),
        compliance_region: "RO",
        status: "new",
      })
      .select("id")
      .single();
    if (error) throw new Error(`Planting a lead failed: ${error.message}`);
    return (data as { id: string }).id;
  }

  const reachable = await plant(picked.withAddress.company_id);
  const unreachable = await plant(picked.noDomain.id);
  const noAddress = await plant(picked.domainNoAddress.id);

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn } = await client.auth.signInWithPassword({ email, password });
  const session = signIn.session;

  // --- who may ask -----------------------------------------------------------
  const anon = await call(`/api/v1/leads/${reachable}/enrich`, null);
  check("unauthenticated enrichment is refused", anon.status === 401, anon);

  const missing = await call(
    "/api/v1/leads/00000000-0000-4000-8000-000000000000/enrich",
    session,
  );
  check("an unknown lead is a 404", missing.status === 404, missing);

  // The existing workspace's leads are real and belong to someone else. RLS
  // should make them read as missing rather than as forbidden.
  const { data: foreign } = await admin
    .from("leads")
    .select("id")
    .neq("org_id", org!.id)
    .limit(1);
  if (foreign?.length) {
    const other = await call(`/api/v1/leads/${(foreign[0] as { id: string }).id}/enrich`, session);
    check("another workspace's lead is a 404, not a 403", other.status === 404, other);
  }

  // --- the lead we can reach -------------------------------------------------
  const hit = await call(`/api/v1/leads/${reachable}/enrich`, session);
  check("enriching a reachable lead succeeds", hit.status === 200, hit);

  const found = hit.body.email as
    | { address: string; status: string; isRoleAddress: boolean; provider: string }
    | null;
  check("it returns an address", Boolean(found), hit.body);
  check(
    `the address is the harvested one (${found?.address})`,
    found?.address === picked.withAddress.address,
    { got: found?.address, want: picked.withAddress.address },
  );
  check("it is labelled a role address", found?.isRoleAddress === true, found);
  check("its status is found, not verified", found?.status === "found", found);

  const score = hit.body.score as { before: number; after: number };
  check(
    `the score moved off the no-email ceiling (${score?.before} → ${score?.after})`,
    score?.before === 45 && score?.after > 45,
    score,
  );

  const { data: savedLead } = await admin
    .from("leads")
    .select("email_id, score, enriched_at, score_breakdown")
    .eq("id", reachable)
    .single();
  const saved = savedLead as Record<string, unknown>;
  check("the lead now points at an emails row", Boolean(saved.email_id), saved);
  check("the stored score matches what was returned", saved.score === score?.after, saved);
  check("enriched_at is stamped", Boolean(saved.enriched_at));
  check(
    "the stored breakdown explains the contactability",
    ((saved.score_breakdown as ScoreBreakdown)?.contactability?.score ?? 0) > 0,
    saved.score_breakdown,
  );

  // --- the lead with no domain ----------------------------------------------
  const skipped = await call(`/api/v1/leads/${unreachable}/enrich`, session);
  check("a lead with no domain still returns 200", skipped.status === 200, skipped);
  check("it says why it did nothing", skipped.body.skipped === "no_domain", skipped.body);
  check("it invents no address", skipped.body.email === null, skipped.body);

  const { data: skippedLead } = await admin
    .from("leads")
    .select("email_id, score")
    .eq("id", unreachable)
    .single();
  check(
    "its score is unchanged and it has no address",
    (skippedLead as Record<string, unknown>).email_id === null &&
      (skippedLead as Record<string, unknown>).score === 45,
    skippedLead,
  );

  // --- the lead we crawl and find nothing for -------------------------------
  const miss = await call(`/api/v1/leads/${noAddress}/enrich`, session);
  check("a fruitless crawl still returns 200", miss.status === 200, miss);
  const { data: missLead } = await admin
    .from("leads")
    .select("enriched_at")
    .eq("id", noAddress)
    .single();
  check(
    "the miss is recorded, so a bulk re-run will not repeat it",
    Boolean((missLead as Record<string, unknown>).enriched_at),
    missLead,
  );
  console.log(
    `           (${picked.domainNoAddress.domain} → ` +
      `${(miss.body.email as { address: string } | null)?.address ?? "no address"})`,
  );

  // --- a second run must not duplicate --------------------------------------
  const again = await call(`/api/v1/leads/${reachable}/enrich`, session);
  check("re-enriching the same lead succeeds", again.status === 200, again);

  const { count: emailsAfter } = await admin
    .from("emails")
    .select("id", { count: "exact", head: true });
  const { data: duplicates } = await admin
    .from("emails")
    .select("id")
    .eq("company_id", picked.withAddress.company_id)
    .eq("address", picked.withAddress.address);
  check(
    `the address is stored once, not once per run (${duplicates?.length ?? 0} row)`,
    (duplicates?.length ?? 0) === 1,
    duplicates,
  );
  console.log(`           (${emailsBefore} → ${emailsAfter} email rows overall)`);

  for (const undo of cleanup.reverse()) await undo();
  check("test workspace removed", true);

  console.log(
    failures === 0
      ? "\nEnrichment works end to end, through the route a user actually hits."
      : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
  process.exit(1);
});
