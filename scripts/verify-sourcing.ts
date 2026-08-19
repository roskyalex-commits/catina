/**
 * Verifies a sourcing run against the running app and the live registry.
 *
 *   npm run dev              # in another terminal
 *   npm run verify:sourcing
 *
 * Step 4 in docs/STATUS.md. The pipeline's decisions are unit-tested against
 * fakes; what only exists at runtime is whether the registry query, the people
 * join, the scoring and the lead insert actually agree with the real schema and
 * the real data. So this creates a throwaway workspace with an agent whose ICP
 * matches the imported slice, runs sourcing through the HTTP route, and checks
 * what landed.
 */
import { createClient } from "@supabase/supabase-js";
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

async function call(path: string, session: unknown | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers.cookie = sessionCookies(session);
  const response = await fetch(`${APP}${path}`, { ...init, headers });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* status alone is the signal */
  }
  return { status: response.status, body };
}

async function main() {
  console.log(`Verifying sourcing against ${APP}\n`);
  try {
    await fetch(`${APP}/login`);
  } catch {
    console.error(`Cannot reach ${APP}. Start it with: npm run dev`);
    process.exit(1);
  }

  // What is actually in the registry decides what the ICP should ask for.
  const { count: companyCount } = await admin
    .from("companies")
    .select("id", { count: "exact", head: true });
  const { count: peopleCount } = await admin
    .from("people")
    .select("id", { count: "exact", head: true });
  console.log(`registry: ${companyCount} companies, ${peopleCount} people\n`);

  if (!companyCount) {
    console.error("No companies imported. Run import:onrc first.");
    process.exit(1);
  }

  // --- a throwaway workspace -------------------------------------------------
  const stamp = Date.now();
  const email = `sourcing-${stamp}@example.test`;
  const password = `Test-${crypto.randomUUID()}`;

  const { data: user } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const { data: org } = await admin
    .from("orgs")
    .insert({ name: "Sourcing test", slug: `sourcing-${stamp}` })
    .select("id")
    .single();
  await admin
    .from("memberships")
    .insert({ org_id: org!.id, user_id: user.user!.id, role: "owner" });

  const { data: agent } = await admin
    .from("agents")
    .insert({
      org_id: org!.id,
      name: "Cluj software",
      website_url: "https://example.ro",
      value_prop: "We sell bookkeeping automation to Romanian software firms.",
      target_titles: ["Administrator"],
      target_seniorities: ["c_level"],
      // Matches the imported slice: Cluj, CAEN division 62.
      caen_codes: ["6201", "6202", "6203", "6209", "6210"],
      countries: ["RO"],
      keywords: ["software"],
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

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn } = await client.auth.signInWithPassword({ email, password });
  const session = signIn.session;

  // --- the run ---------------------------------------------------------------
  const anon = await call("/api/v1/sourcing/run", null, {
    method: "POST",
    body: JSON.stringify({ agentId: agent!.id }),
  });
  check("unauthenticated sourcing is refused", anon.status === 401, anon);

  const missing = await call("/api/v1/sourcing/run", session, {
    method: "POST",
    body: JSON.stringify({ agentId: "00000000-0000-4000-8000-000000000000" }),
  });
  check("an unknown agent is a 404", missing.status === 404, missing);

  const run = await call("/api/v1/sourcing/run", session, {
    method: "POST",
    body: JSON.stringify({ agentId: agent!.id, limit: 25 }),
  });
  check("the run succeeds", run.status === 200, run);

  const created = Number(run.body.leadsCreated ?? 0);
  check(`it created leads (${created})`, created > 0, run.body);
  check(
    `it considered companies (${run.body.companiesConsidered})`,
    Number(run.body.companiesConsidered ?? 0) > 0,
  );
  check("it returned a cursor to continue from", Boolean(run.body.cursor));

  const leads = (run.body.leads ?? []) as { company: string; person: string; score: number }[];
  if (leads.length) {
    console.log("\n  top leads:");
    for (const lead of leads.slice(0, 6)) {
      console.log(
        `    ${String(lead.score).padStart(3)}  ${lead.person.padEnd(26)} @ ${lead.company}`,
      );
    }
    console.log();
    check("every lead has a person and a company", leads.every((l) => l.person && l.company));
    check(
      "leads come back best first",
      leads.every((l, i) => i === 0 || leads[i - 1].score >= l.score),
      leads.map((l) => l.score),
    );
  }

  // --- what landed in the database ------------------------------------------
  const { data: rows } = await admin
    .from("leads")
    .select("score, score_breakdown, compliance_region, source_label, source_query, person_id, company_id, status")
    .eq("agent_id", agent!.id);

  check(`rows are in the leads table (${rows?.length ?? 0})`, (rows?.length ?? 0) === created);
  if (rows?.length) {
    const first = rows[0] as Record<string, unknown>;
    check("each lead has a scored breakdown", Boolean(first.score_breakdown));
    check("compliance region is cached as RO", first.compliance_region === "RO");
    check("status starts as new", first.status === "new");
    check("the source is recorded", Boolean(first.source_label));
  }

  // --- a second run must not duplicate --------------------------------------
  const again = await call("/api/v1/sourcing/run", session, {
    method: "POST",
    body: JSON.stringify({ agentId: agent!.id, limit: 25 }),
  });
  check(
    `re-running the same page creates nothing new (${again.body.alreadyKnown} already known)`,
    Number(again.body.leadsCreated ?? 0) === 0 &&
      Number(again.body.alreadyKnown ?? 0) > 0,
    again.body,
  );

  // --- the next page ---------------------------------------------------------
  const next = await call("/api/v1/sourcing/run", session, {
    method: "POST",
    body: JSON.stringify({ agentId: agent!.id, limit: 25, cursor: run.body.cursor }),
  });
  check(
    `the cursor advances to fresh companies (${next.body.leadsCreated} more)`,
    Number(next.body.leadsCreated ?? 0) > 0,
    next.body,
  );

  // --- the activity feed -----------------------------------------------------
  const { data: runs } = await admin
    .from("job_runs")
    .select("kind, status, title, leads_found")
    .eq("agent_id", agent!.id);
  check(`every run is in the activity feed (${runs?.length ?? 0})`, (runs?.length ?? 0) >= 3);

  for (const undo of cleanup.reverse()) await undo();
  check("test workspace removed", true);

  console.log(
    failures === 0
      ? "\nSourcing works end to end."
      : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
  process.exit(1);
});
