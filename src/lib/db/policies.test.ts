import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

/**
 * The tenancy boundary, exercised for real.
 *
 * `drizzle/policies.sql` is the actual boundary in this app — runtime queries go
 * through PostgREST with the caller's JWT, so a missing policy is a cross-org
 * data leak rather than an error anyone would notice. docs/STATUS.md recorded
 * this as untestable, because proving it needs a Postgres and the environment
 * had none.
 *
 * PGlite is real Postgres compiled to WASM, in-process: no daemon, no network,
 * no Supabase. So the schema and the policy file can be applied exactly as
 * `npm run db:setup` applies them, and the isolation they are supposed to
 * provide can be asserted directly. Runs in about a second.
 *
 * This does not replace `npm run verify:rls`. That one signs real JWTs against
 * a live project and proves Supabase is configured correctly; this proves the
 * SQL itself is correct, which is the half that used to be unprovable.
 */

const MIGRATIONS_DIR = "drizzle";

/**
 * Every migration, in order — not just the first one.
 *
 * This used to name `0000_sleepy_stark_industries.sql` directly, which quietly
 * meant the test asserted policies against a schema several migrations behind.
 * It broke the moment `policies.sql` referenced a table a later migration
 * created, which is exactly when a schema test should notice.
 */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}
const POLICIES_SQL = "drizzle/policies.sql";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NO_ORG_USER = "99999999-9999-4999-8999-999999999999";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/**
 * What Supabase provides and plain Postgres does not: the `auth` schema, the
 * `auth.uid()` the policies are written against, and the three roles. The
 * shim reads the same GUC PostgREST sets, so `auth.uid()` behaves as it will in
 * production.
 */
const SUPABASE_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid
    language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  end $$;
`;

/**
 * Supabase grants table privileges to `authenticated`; RLS then narrows them.
 * Without these grants the role could not see the tables at all and every
 * assertion below would pass for entirely the wrong reason.
 */
const GRANTS = `
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
`;

const SEED = `
  insert into auth.users (id) values ('${USER_A}'), ('${USER_B}');
  insert into orgs (id, name, slug) values
    ('${ORG_A}', 'Org A', 'org-a'), ('${ORG_B}', 'Org B', 'org-b');
  insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${USER_B}', 'owner');

  insert into agents (id, org_id, name, website_url) values
    ('33333333-3333-4333-8333-333333333333', '${ORG_A}', 'A agent', 'https://a.ro');
  insert into lists (id, org_id, name) values
    ('44444444-4444-4444-8444-444444444444', '${ORG_A}', 'A list');
  insert into campaigns (id, org_id, agent_id, name) values
    ('55555555-5555-4555-8555-555555555555', '${ORG_A}',
     '33333333-3333-4333-8333-333333333333', 'A campaign');
  insert into sequence_steps (id, campaign_id, step_index, instruction) values
    ('66666666-6666-4666-8666-666666666666',
     '55555555-5555-4555-8555-555555555555', 0, 'hello');
  insert into email_accounts
    (id, org_id, user_id, address, provider, encrypted_refresh_token) values
    ('77777777-7777-4777-8777-777777777777', '${ORG_A}', '${USER_A}',
     'a@a.ro', 'gmail', 'enc');
  insert into companies (id, name, source) values
    ('88888888-8888-4888-8888-888888888888', 'Public SRL', 'onrc');
`;

let db: PGlite;

/** Run a statement as an authenticated end user with the given JWT subject. */
async function asUser(userId: string, sql: string) {
  await db.exec(
    `set role authenticated; set request.jwt.claim.sub = '${userId}';`,
  );
  try {
    return await db.query(sql);
  } finally {
    await db.exec("reset role; reset request.jwt.claim.sub;");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_SHIM);

  // drizzle separates statements with this marker.
  for (const file of migrationFiles()) {
    for (const statement of readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.exec(statement);
    }
  }

  // Applied in one call, exactly as scripts/apply-policies.ts does, so a syntax
  // error anywhere fails here the same way it would there.
  await db.exec(readFileSync(POLICIES_SQL, "utf8"));
  await db.exec(GRANTS);
  await db.exec(SEED);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("schema and policies apply", () => {
  it("creates every table", async () => {
    // Named rather than counted: a bare number has to be edited on every
    // migration and says nothing about which table went missing when it fails.
    const { rows } = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public'",
    );
    const tables = new Set(rows.map((row) => row.tablename));

    for (const table of [
      "orgs", "memberships", "agents", "companies", "people", "emails",
      "signals", "company_scans", "leads", "lists", "list_members",
      "campaigns", "sequence_steps", "messages", "job_runs", "suppressions",
      "email_accounts", "provider_usage",
    ]) {
      expect(tables, `${table} is missing`).toContain(table);
    }
  });

  it("enables RLS on every table carrying org_id", async () => {
    // The one that matters: an org_id table without RLS is a cross-org leak.
    const { rows } = await db.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
       where c.table_schema='public' and c.column_name='org_id'
         and not exists (
           select 1 from pg_class pc join pg_namespace n on n.oid=pc.relnamespace
           where n.nspname='public' and pc.relname=c.table_name and pc.relrowsecurity
         )`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it("creates the helper functions the app calls", async () => {
    const { rows } = await db.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and proname in
         ('current_org_ids','increment_provider_usage') order by proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "current_org_ids",
      "increment_provider_usage",
    ]);
  });
});

describe("tenant isolation", () => {
  const TENANT_TABLES = ["agents", "lists", "campaigns", "sequence_steps"];

  it.each(TENANT_TABLES)("%s: the owner sees their row", async (table) => {
    const { rows } = await asUser(USER_A, `select * from ${table}`);
    expect(rows).toHaveLength(1);
  });

  it.each(TENANT_TABLES)("%s: another org sees nothing", async (table) => {
    // User B is legitimate and authenticated — exactly the case application
    // code cannot be trusted to get right.
    const { rows } = await asUser(USER_B, `select * from ${table}`);
    expect(rows).toHaveLength(0);
  });

  it("shows each user only their own org", async () => {
    const a = await asUser(USER_A, "select slug from orgs");
    const b = await asUser(USER_B, "select slug from orgs");
    expect(a.rows).toEqual([{ slug: "org-a" }]);
    expect(b.rows).toEqual([{ slug: "org-b" }]);
  });

  it("shows a user with no membership nothing at all", async () => {
    const { rows } = await asUser(NO_ORG_USER, "select * from agents");
    expect(rows).toHaveLength(0);
  });
});

describe("writes are bounded too", () => {
  it("blocks an insert into another org", async () => {
    // A boundary that only covers reads is still a leak.
    await expect(
      asUser(
        USER_B,
        `insert into agents (org_id, name, website_url)
         values ('${ORG_A}', 'sneaky', 'https://x.ro')`,
      ),
    ).rejects.toThrow();
  });

  it("makes an update of another org's row affect nothing", async () => {
    await asUser(USER_B, `update agents set name='hijacked' where org_id='${ORG_A}'`);
    const { rows } = await db.query<{ name: string }>(
      `select name from agents where org_id='${ORG_A}'`,
    );
    expect(rows[0].name).toBe("A agent");
  });

  it("makes a delete of another org's row remove nothing", async () => {
    await asUser(USER_B, `delete from agents where org_id='${ORG_A}'`);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from agents",
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("secrets and shared data", () => {
  it("hides email_accounts even from its own org", async () => {
    // RLS on with no permissive policy: refresh tokens are service-role only.
    const { rows } = await asUser(USER_A, "select * from email_accounts");
    expect(rows).toHaveLength(0);
  });

  it("hides provider_usage from users", async () => {
    const { rows } = await asUser(USER_A, "select * from provider_usage");
    expect(rows).toHaveLength(0);
  });

  it("keeps registry data readable by any authenticated user", async () => {
    // companies/people/emails/signals/company_scans are public reference data.
    const { rows } = await asUser(USER_B, "select * from companies");
    expect(rows).toHaveLength(1);
  });

  it("lets any authenticated user read signals and scan state", async () => {
    // The sourcing route scores on the caller's session, so it must be able to
    // read signals for companies it did not create.
    await expect(asUser(USER_B, "select * from signals")).resolves.toBeDefined();
    await expect(asUser(USER_B, "select * from company_scans")).resolves.toBeDefined();
  });

  it("lets nobody but the service role write signals or scan state", async () => {
    // These are facts about a public company, not about a tenant. A user who
    // could write them would be writing into every other workspace's scoring.
    const company = "11111111-1111-4111-8111-111111111111";

    await expect(
      asUser(
        USER_A,
        `insert into signals (company_id, type, title, dedupe_key)
         values ('${company}'::uuid, 'hiring_surge', 'x', 'k1')`,
      ),
    ).rejects.toThrow();

    await expect(
      asUser(
        USER_A,
        `insert into company_scans (company_id) values ('${company}'::uuid)`,
      ),
    ).rejects.toThrow();
  });
});

describe("increment_provider_usage", () => {
  it("accumulates rather than overwriting", async () => {
    // Enrichment runs concurrently; a read-modify-write would lose updates and
    // overspend a free tier into 429s. Also proves the schema-qualified
    // reference inside ON CONFLICT DO UPDATE is valid SQL.
    await db.exec(`
      select public.increment_provider_usage('${ORG_A}'::uuid, 'hunter', '2026-08', 5, 50);
      select public.increment_provider_usage('${ORG_A}'::uuid, 'hunter', '2026-08', 3, 50);
    `);
    const { rows } = await db.query<{ credits_used: number }>(
      "select credits_used from provider_usage where provider='hunter'",
    );
    expect(Number(rows[0].credits_used)).toBe(8);
  });
});
