/**
 * Applies drizzle/policies.sql to the database.
 *
 * Run after every schema migration — drizzle-kit does not manage RLS, and an
 * un-policied tenant table is a cross-org data leak, so this is not optional.
 *
 *   npm run db:policies
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { requireEnv } from "./load-env";

async function main() {
  const url = requireEnv(
    "DATABASE_URL",
    "Use the Supabase session pooler URI (port 5432), not the direct connection.",
  );

  const sqlText = await readFile(
    join(process.cwd(), "drizzle", "policies.sql"),
    "utf8",
  );

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(sqlText);
    console.log("✓ RLS policies applied");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("✗ Failed to apply policies:", err);
  process.exit(1);
});
