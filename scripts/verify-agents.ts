/**
 * Verifies agent persistence against the running app and a live database.
 *
 *   npm run dev            # in another terminal
 *   npm run verify:agents
 *
 * Step 2 in docs/STATUS.md was written and unit-tested but had never touched a
 * database. The unit tests cover the mapping either side of PostgREST; what
 * they cannot cover is the part that only exists at runtime — that the route
 * uses the caller's JWT so RLS applies, that org_id comes from the membership
 * rather than the body, that the insert matches the real column types, and that
 * the plan cap counts the right rows.
 *
 * So this drives the actual HTTP route with a real signed-in user, the way the
 * wizard does. Throwaway tenants, cleaned up at the end.
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
    if (detail !== undefined) {
      console.log("          ", JSON.stringify(detail).slice(0, 300));
    }
  }
}

/** A valid payload, matching what the onboarding wizard posts. */
const VALID = {
  name: "Romania · Finance & Ops",
  websiteUrl: "https://example.ro",
  valueProp: "We sell bookkeeping automation to Romanian accounting firms.",
  productName: "Ledger",
  targetTitles: ["CEO", "Director Financiar"],
  targetSeniorities: ["c_level"],
  industries: ["Accounting"],
  caenCodes: ["6920"],
  companyTypes: ["smb"],
  countries: ["RO"],
  keywords: ["contabilitate", "facturare"],
  exclusions: ["banks"],
  employeeMin: 5,
  employeeMax: 200,
  revenueMinRon: 500000,
  revenueMaxRon: null,
  confidence: 0.8,
  assumptions: ["Pricing page did not list tiers."],
  enabledSignals: ["anaf_growth", "hiring"],
};

async function createTenant(slug: string) {
  const stamp = Date.now();
  const email = `agents-${slug}-${stamp}@example.test`;
  const password = `Test-${crypto.randomUUID()}`;

  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`createUser: ${userError?.message}`);

  const { data: org, error: orgError } = await admin
    .from("orgs")
    .insert({ name: `Agents ${slug}`, slug: `agents-${slug}-${stamp}` })
    .select("id")
    .single();
  if (orgError || !org) throw new Error(`create org: ${orgError?.message}`);

  const { error: memberError } = await admin
    .from("memberships")
    .insert({ org_id: org.id, user_id: user.user.id, role: "owner" });
  if (memberError) throw new Error(`membership: ${memberError.message}`);

  cleanup.push(async () => {
    await admin.from("agents").delete().eq("org_id", org.id);
    await admin.from("orgs").delete().eq("id", org.id);
    await admin.auth.admin.deleteUser(user.user!.id);
  });

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } =
    await client.auth.signInWithPassword({ email, password });
  if (signInError || !session.session) {
    throw new Error(`sign in: ${signInError?.message}`);
  }

  return { orgId: org.id as string, session: session.session };
}

/** @supabase/ssr splits an oversized cookie into `name.0`, `name.1`, … */
const MAX_CHUNK_SIZE = 3180;

/**
 * Serialise a session the way @supabase/ssr stores it in the browser.
 *
 * The route reads the caller from cookies, not from an Authorization header —
 * that is the whole point, since it is the cookie session that PostgREST turns
 * into the JWT that RLS is evaluated against. So the test client has to write
 * the cookie in exactly the format the server will parse: the full session
 * object, JSON, base64 with a `base64-` marker, chunked past 3180 characters.
 */
function sessionCookies(session: unknown): string {
  const ref = new URL(url).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

  if (value.length <= MAX_CHUNK_SIZE) return `${name}=${value}`;

  const chunks: string[] = [];
  for (let i = 0; i * MAX_CHUNK_SIZE < value.length; i += 1) {
    chunks.push(
      `${name}.${i}=${value.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE)}`,
    );
  }
  return chunks.join("; ");
}

/** Call the route the way a browser does. */
async function call(
  path: string,
  session: unknown | null,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (session) headers.cookie = sessionCookies(session);
  const response = await fetch(`${APP}${path}`, { ...init, headers });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON response; status alone is the signal */
  }
  return { status: response.status, body };
}

async function main() {
  console.log(`Verifying agent persistence against ${APP}\n`);

  // The app must be running, or every check below fails for the wrong reason.
  try {
    await fetch(`${APP}/login`);
  } catch {
    console.error(`Cannot reach ${APP}. Start it with: npm run dev`);
    process.exit(1);
  }

  // --- unauthenticated -------------------------------------------------------
  const anon = await call("/api/v1/agents", null);
  check("GET without a session is refused", anon.status === 401, anon);

  const anonPost = await call("/api/v1/agents", null, {
    method: "POST",
    body: JSON.stringify(VALID),
  });
  check("POST without a session is refused", anonPost.status === 401, anonPost);

  // --- authenticated ---------------------------------------------------------
  const a = await createTenant("a");
  const b = await createTenant("b");

  const empty = await call("/api/v1/agents", a.session);
  check(
    "a new workspace starts with no agents",
    empty.status === 200 && Array.isArray(empty.body.agents) &&
      (empty.body.agents as unknown[]).length === 0,
    empty,
  );

  const created = await call("/api/v1/agents", a.session, {
    method: "POST",
    body: JSON.stringify(VALID),
  });
  const agent = created.body.agent as Record<string, unknown> | undefined;
  check("POST creates an agent", created.status === 201 && Boolean(agent), created);

  if (agent) {
    check("it comes back as a draft", agent.status === "draft", agent.status);
    check("it keeps the name it was given", agent.name === VALID.name, agent.name);
    check(
      "it reports no mailbox, since Gmail is not connected",
      agent.mailbox === null,
      agent.mailbox,
    );
    check("counts start at zero", agent.leadsFound === 0 && agent.contacted === 0);

    // The row itself: read with the service role so RLS cannot mask a mistake.
    const { data: row } = await admin
      .from("agents")
      .select("org_id, caen_codes, target_seniorities, revenue_min_ron, revenue_max_ron, source_evidence, confidence")
      .eq("id", agent.id as string)
      .single();

    check("the row is owned by the caller's org", row?.org_id === a.orgId, row?.org_id);
    check("array columns round-trip", JSON.stringify(row?.caen_codes) === JSON.stringify(["6920"]), row?.caen_codes);
    check("enum-ish arrays round-trip", JSON.stringify(row?.target_seniorities) === JSON.stringify(["c_level"]), row?.target_seniorities);
    check("a numeric bound round-trips", Number(row?.revenue_min_ron) === 500000, row?.revenue_min_ron);
    check("a null bound stays null, not zero", row?.revenue_max_ron === null, row?.revenue_max_ron);
    check("assumptions land in jsonb", Boolean((row?.source_evidence as { assumptions?: unknown })?.assumptions), row?.source_evidence);
  }

  const listed = await call("/api/v1/agents", a.session);
  check(
    "GET returns the created agent",
    listed.status === 200 && (listed.body.agents as unknown[])?.length === 1,
    listed,
  );

  // --- the boundary, through the route --------------------------------------
  const otherOrg = await call("/api/v1/agents", b.session);
  check(
    "another workspace does not see it",
    otherOrg.status === 200 && (otherOrg.body.agents as unknown[])?.length === 0,
    otherOrg,
  );

  // --- validation ------------------------------------------------------------
  const bad = await call("/api/v1/agents", b.session, {
    method: "POST",
    body: JSON.stringify({ ...VALID, name: "", caenCodes: ["nope"] }),
  });
  check("an invalid payload is rejected with issues", bad.status === 400 && Array.isArray(bad.body.issues), bad);

  const spoofed = await call("/api/v1/agents", b.session, {
    method: "POST",
    body: JSON.stringify({ ...VALID, orgId: a.orgId, org_id: a.orgId }),
  });
  if (spoofed.status === 201) {
    const { data: row } = await admin
      .from("agents")
      .select("org_id")
      .eq("id", (spoofed.body.agent as Record<string, unknown>).id as string)
      .single();
    check("org_id in the body is ignored", row?.org_id === b.orgId, row?.org_id);
  } else {
    check("org_id in the body is ignored", false, spoofed);
  }

  // --- plan cap --------------------------------------------------------------
  const second = await call("/api/v1/agents", a.session, {
    method: "POST",
    body: JSON.stringify({ ...VALID, name: "Second agent" }),
  });
  check(
    "the free plan's one-agent cap is enforced",
    second.status === 402 && second.body.code === "plan_limit",
    second,
  );

  // --- cleanup ---------------------------------------------------------------
  for (const undo of cleanup.reverse()) await undo();
  const { count } = await admin
    .from("agents")
    .select("id", { count: "exact", head: true })
    .in("org_id", [a.orgId, b.orgId]);
  check("test tenants removed", (count ?? 0) === 0);

  console.log(
    failures === 0
      ? "\nAgent persistence works end to end."
      : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
  process.exit(1);
});
