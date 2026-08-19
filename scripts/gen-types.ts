/**
 * Regenerates src/lib/supabase/types.ts from the live database schema.
 *
 *   npm run db:types
 *
 * Replaces the placeholder `Database` type described in docs/STATUS.md. Until
 * this has run, every selected column arrives as `unknown` and the helpers in
 * `src/lib/supabase/row.ts` narrow at runtime instead. Those helpers stay
 * correct afterwards — just redundant — so nothing has to be unpicked.
 *
 * This was an inline npm script. It became a file for three reasons, each of
 * which broke it before a database ever existed:
 *
 *   1. it called a bare `supabase`, which is not a dependency and is not
 *      installed globally, so it failed with "command not found";
 *   2. it referenced `$SUPABASE_PROJECT_ID`, which is defined in no env file
 *      and documented nowhere;
 *   3. `$VAR` and `>` are shell syntax, and npm on Windows runs scripts through
 *      cmd.exe, where neither behaves as written.
 *
 * Using `--db-url` also avoids `supabase login`: DATABASE_URL is already
 * configured for migrations, and the project ref is embedded in it.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { requireEnv } from "./load-env";

const OUTPUT = "src/lib/supabase/types.ts";

function main() {
  const dbUrl = requireEnv(
    "DATABASE_URL",
    "Use the Supabase session pooler URI (port 5432), not the direct connection.",
  );

  console.log("Generating types from the live schema…");

  const result = spawnSync(
    "npx",
    [
      "--yes",
      "supabase@latest",
      "gen",
      "types",
      "typescript",
      "--db-url",
      dbUrl,
      "--schema",
      "public",
    ],
    { encoding: "utf8", shell: process.platform === "win32" },
  );

  if (result.error) {
    console.error("Could not run the Supabase CLI:", result.error.message);
    process.exit(1);
  }

  // The CLI writes types to stdout and diagnostics to stderr. Capturing rather
  // than redirecting in the shell is what makes this work identically on
  // Windows and POSIX — and lets a failure be detected before the old file is
  // overwritten with an error message.
  if (result.status !== 0) {
    console.error(result.stderr?.trim() || `Exited with code ${result.status}`);
    process.exit(1);
  }

  const types = result.stdout;
  if (!types.includes("export type Database")) {
    console.error(
      "The CLI produced no Database type. Nothing was written.\n" +
        (result.stderr?.trim() ?? ""),
    );
    process.exit(1);
  }

  writeFileSync(OUTPUT, types, "utf8");
  const tables = (types.match(/\n {6}\w+: \{\n {8}Row:/g) ?? []).length;
  console.log(`✓ Wrote ${OUTPUT}${tables ? ` (${tables} tables)` : ""}`);
}

main();
