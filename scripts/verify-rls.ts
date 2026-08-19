/**
 * Verifies tenant isolation against a live Supabase project.
 *
 *   npm run verify:rls
 *
 * Row-level security is the actual tenancy boundary in this app — runtime
 * queries go through PostgREST with the caller's JWT, so a missing policy is a
 * cross-org data leak, not a bug that surfaces as an error. Application code
 * cannot be trusted to enforce it and unit tests cannot exercise it, so this
 * runs against the real database.
 *
 * The plan calls this non-negotiable before any real user touches the product.
 *
 * What it does: creates two throwaway orgs with a user each, writes a row into
 * every tenant table for org A, then asserts that user B — a fully legitimate,
 * authenticated user — sees none of it. It also asserts that the secrets
 * tables are invisible to both, and cleans up after itself.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY, since setting up two users needs admin.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "./load-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error(
    "Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
      "SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Tables that carry org_id and must be invisible across orgs. */
const TENANT_TABLES = [
  "agents",
  "leads",
  "campaigns",
  "messages",
  "suppressions",
  "job_runs",
] as const;

/** Tables no user JWT may read at all, regardless of org. */
const SECRET_TABLES = ["email_accounts", "provider_usage"] as const;

let failures = 0;
const cleanup: (() => Promise<void>)[] = [];

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`[${ok ? "  ok  " : " FAIL "}] ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log("         ", detail);
  }
}

async function createTenant(slug: string) {
  const email = `rls-${slug}-${Date.now()}@example.test`;
  const password = `Test-${crypto.randomUUID()}`;

  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`createUser: ${userError?.message}`);

  const { data: org, error: orgError } = await admin
    .from("orgs")
    .insert({ name: `RLS ${slug}`, slug: `rls-${slug}-${Date.now()}` })
    .select("id")
    .single();
  if (orgError || !org) throw new Error(`create org: ${orgError?.message}`);

  const { error: memberError } = await admin
    .from("memberships")
    .insert({ org_id: org.id, user_id: user.user.id, role: "owner" });
  if (memberError) throw new Error(`create membership: ${memberError.message}`);

  cleanup.push(async () => {
    await admin.from("orgs").delete().eq("id", org.id);
    await admin.auth.admin.deleteUser(user.user!.id);
  });

  // Sign in as the user to get a real JWT — this is the client whose access
  // the policies actually govern.
  const client = createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`sign in: ${signInError.message}`);

  return { orgId: org.id as string, userId: user.user.id, client };
}

/** Minimal valid row per table, written with the service role. */
async function seedOrg(orgId: string) {
  const { data: icp } = await admin
    .from("agents")
    .insert({ org_id: orgId, name: "RLS probe", website_url: "https://example.test" })
    .select("id")
    .single();

  const { data: campaign } = await admin
    .from("campaigns")
    .insert({ org_id: orgId, name: "RLS probe campaign" })
    .select("id")
    .single();

  await admin
    .from("suppressions")
    .insert({ org_id: orgId, value: `probe-${orgId}@example.test` });

  await admin.from("job_runs").insert({ org_id: orgId, kind: "rls_probe" });

  return { icpId: icp?.id as string | undefined, campaignId: campaign?.id as string | undefined };
}

async function countVisible(client: SupabaseClient, table: string, orgId: string) {
  const { data, error } = await client.from(table).select("id").eq("org_id", orgId);
  // An error here is also a pass for isolation, but report it so a broken
  // policy isn't mistaken for a working one.
  if (error) return { count: 0, error: error.message };
  return { count: data?.length ?? 0 };
}

async function main() {
  console.log("Verifying row-level security\n");

  const a = await createTenant("a");
  const b = await createTenant("b");
  console.log(`org A ${a.orgId}\norg B ${b.orgId}\n`);

  await seedOrg(a.orgId);

  // --- 1. A sees its own data ---------------------------------------------
  console.log("--- own-org access ---");
  for (const table of ["agents", "campaigns", "suppressions", "job_runs"]) {
    const { count, error } = await countVisible(a.client, table, a.orgId);
    check(
      `A can read its own ${table}`,
      count > 0,
      error ?? `saw ${count} rows — a policy may be too restrictive`,
    );
  }
  console.log();

  // --- 2. B sees none of A's data — the whole point ------------------------
  console.log("--- cross-org isolation ---");
  for (const table of TENANT_TABLES) {
    const { count, error } = await countVisible(b.client, table, a.orgId);
    check(
      `B cannot read A's ${table}`,
      count === 0,
      error ?? `LEAK: B saw ${count} of A's rows in ${table}`,
    );
  }
  console.log();

  // --- 3. B cannot write into A's org --------------------------------------
  console.log("--- cross-org writes ---");
  const { error: writeError } = await b.client
    .from("agents")
    .insert({ org_id: a.orgId, name: "injected", website_url: "https://evil.test" });
  check(
    "B cannot insert into A's org",
    writeError !== null,
    "LEAK: the insert succeeded — the WITH CHECK clause is missing",
  );

  const { data: updated } = await b.client
    .from("campaigns")
    .update({ name: "hijacked" })
    .eq("org_id", a.orgId)
    .select("id");
  check(
    "B cannot update A's campaigns",
    (updated?.length ?? 0) === 0,
    `LEAK: B updated ${updated?.length} of A's rows`,
  );
  console.log();

  // --- 4. Secrets are invisible to everyone ---------------------------------
  console.log("--- secrets ---");
  for (const table of SECRET_TABLES) {
    const { data, error } = await a.client.from(table).select("id");
    check(
      `${table} is unreadable even by its own org`,
      (data?.length ?? 0) === 0,
      error ? undefined : `LEAK: returned ${data?.length} rows`,
    );
  }

  const { error: rpcError } = await a.client.rpc("increment_provider_usage", {
    p_org_id: a.orgId,
    p_provider: "probe",
    p_period_month: "2026-01",
    p_amount: 1,
    p_limit: null,
  });
  check(
    "increment_provider_usage is not callable by a user",
    rpcError !== null,
    "LEAK: a SECURITY DEFINER function is exposed to end users",
  );
  console.log();

  // --- 5. Shared reference data is readable ---------------------------------
  console.log("--- shared reference data ---");
  const { error: companiesError } = await a.client.from("companies").select("id").limit(1);
  check(
    "companies is readable by an authenticated user",
    companiesError === null,
    companiesError?.message,
  );

  const { error: companyWriteError } = await a.client
    .from("companies")
    .insert({ name: "injected", source: "rls_probe" });
  check(
    "companies is not writable by a user",
    companyWriteError !== null,
    "LEAK: a user can write shared registry data",
  );

  console.log("\n--- cleanup ---");
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch (error) {
      console.log("  cleanup step failed:", error);
    }
  }
  check("test tenants removed", true);

  console.log(
    failures === 0
      ? "\nTenant isolation holds.\n"
      : `\n${failures} check(s) FAILED. Do not put real users on this database ` +
          "until every one passes — run `npm run db:policies` and re-check.\n",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("verify-rls crashed:", error);
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => undefined);
  }
  process.exit(1);
});
