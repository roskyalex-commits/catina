/**
 * Recomputes `companies.caen_label` from `companies.caen`.
 *
 *   npm run repair:caen-labels -- --file ~/Downloads/n_caen.csv --dry-run
 *   npm run repair:caen-labels -- --file ~/Downloads/n_caen.csv
 *
 * The column is wrong for a large share of rows and has been since the first
 * import. `import-onrc.ts` set it from ONRC's *authorised* activity, then
 * `enrich-registry.ts` overwrote `caen` with the activity ANAF says the company
 * actually files under — and never touched the label beside it. The two have
 * described different activities ever since. Measured before this ran: code
 * `7311` (advertising agencies) carried six different labels, several of them
 * about software.
 *
 * A label nobody can trust is worse than no label, because it is the field a
 * person reads when deciding whether a lead is a fit. This makes the pair
 * consistent by construction: the label always comes from the nomenclator entry
 * for the code that is actually stored.
 *
 * ## The revision it picks
 *
 * `companies.caen` does not record which CAEN revision the code was filed
 * under, and 130 codes are worded differently between 2008 and 2025 — a few,
 * like `2051`, mean genuinely different activities. The newest revision that
 * defines the code wins, which is right for a company registering today and a
 * coin flip for one that filed under the old scheme. Acceptable only because
 * this field is **display-only**: nothing queries it, and
 * `industry-definitions.ts` exists precisely so that targeting keys off `caen`
 * instead. Do not start querying this column.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";

const PAGE = 1000;
const WRITE_BATCH = 200;
/** Only these are live in the data; 1998 and 2003 are dead. */
const LIVE_REVISIONS = ["2", "3"];

type Options = { file: string; dryRun: boolean };

function parseArgs(argv: string[]): Options {
  const options: Options = { file: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--file":
        options.file = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (!options.file) throw new Error("--file <n_caen.csv> is required");
  return options;
}

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** code → label, newest live revision winning. */
function readLabels(path: string): Map<string, string> {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split("^").map((h) => h.trim().toUpperCase());

  const at = (name: string) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`Column ${name} not found in ${path}`);
    return index;
  };
  const classAt = at("CLASA");
  const labelAt = at("DENUMIRE");
  const revisionAt = at("VERSIUNE_CAEN");

  const byCode = new Map<string, { label: string; revision: string }>();
  for (const line of lines.slice(1)) {
    const parts = line.split("^");
    const code = (parts[classAt] ?? "").trim();
    const revision = (parts[revisionAt] ?? "").trim();
    if (!/^\d{4}$/.test(code) || !LIVE_REVISIONS.includes(revision)) continue;

    const existing = byCode.get(code);
    if (!existing || revision > existing.revision) {
      byCode.set(code, { label: (parts[labelAt] ?? "").trim(), revision });
    }
  }
  return new Map([...byCode].map(([code, entry]) => [code, entry.label]));
}

type Row = { id: string; caen: string | null; caen_label: string | null };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const labels = readLabels(options.file);
  console.log(`${labels.size} CAEN classes in the nomenclator\n`);

  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("companies")
      .select("id, caen, caen_label")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const fixes: { id: string; caen_label: string | null }[] = [];
  let correct = 0;
  let noCode = 0;
  let unknownCode = 0;
  const samples: string[] = [];

  for (const row of rows) {
    if (!row.caen) {
      noCode += 1;
      // A company with no code cannot have a meaningful label. Null it rather
      // than leaving whatever the import guessed.
      if (row.caen_label !== null) fixes.push({ id: row.id, caen_label: null });
      continue;
    }

    const expected = labels.get(row.caen);
    if (expected === undefined) {
      // A code the current nomenclator does not define — an old revision, or a
      // typo in the register. Left alone: nulling would destroy the only hint
      // anyone has about what it means.
      unknownCode += 1;
      continue;
    }

    if (row.caen_label === expected) {
      correct += 1;
      continue;
    }

    if (samples.length < 12) {
      samples.push(
        `  ${row.caen}  ${String(row.caen_label ?? "(null)").slice(0, 46).padEnd(48)}` +
          `→ ${expected.slice(0, 46)}`,
      );
    }
    fixes.push({ id: row.id, caen_label: expected });
  }

  console.log(
    `${rows.length} companies\n` +
      `  ${correct} already correct\n` +
      `  ${fixes.length} to fix\n` +
      `  ${unknownCode} carry a code the nomenclator does not define — left alone\n` +
      `  ${noCode} have no code at all\n`,
  );
  for (const sample of samples) console.log(sample);

  if (options.dryRun) {
    console.log("\nDry run — nothing was written.");
    return;
  }
  if (fixes.length === 0) return;

  let written = 0;
  for (let i = 0; i < fixes.length; i += WRITE_BATCH) {
    const batch = fixes.slice(i, i + WRITE_BATCH);
    const results = await Promise.all(
      batch.map(({ id, caen_label }) =>
        db.from("companies").update({ caen_label }).eq("id", id),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      console.error(`\nWrite failed after ${written}: ${failed.error.message}`);
      console.error("Re-running resumes safely — the repair is idempotent.");
      process.exit(1);
    }
    written += batch.length;
    process.stdout.write(`\r  writing: ${written}/${fixes.length}`);
  }
  console.log(`\n✓ Repaired ${written} labels`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
