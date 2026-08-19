/**
 * Reports what actually landed in the database after a signup.
 *
 * A quick read-only check for the first real account: the point of step 1 in
 * docs/STATUS.md is the transition from fixtures to a real workspace, and this
 * says whether that happened in the database rather than in the UI.
 *
 *   npx tsx scripts/check-workspace.ts
 *
 * Uses the service role, so it reports the truth rather than what RLS would
 * show one user. Read-only.
 */
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";

const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const { data: users } = await supabase.auth.admin.listUsers();
  console.log(`auth users:   ${users?.users.length ?? 0}`);
  for (const u of users?.users ?? []) {
    console.log(`  ${u.email}  confirmed=${Boolean(u.email_confirmed_at)}  ${u.id}`);
  }

  for (const table of ["orgs", "memberships", "agents"]) {
    const { data, error, count } = await supabase
      .from(table)
      .select("*", { count: "exact" });
    if (error) {
      console.log(`${table}: ERROR ${error.message}`);
      continue;
    }
    console.log(`\n${table}: ${count ?? 0} row(s)`);
    for (const row of (data ?? []).slice(0, 5)) {
      const r = row as Record<string, unknown>;
      console.log(
        "  " +
          ["id", "name", "slug", "org_id", "user_id", "role", "status"]
            .filter((k) => r[k] !== undefined)
            .map((k) => `${k}=${String(r[k])}`)
            .join("  "),
      );
    }
  }

}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
