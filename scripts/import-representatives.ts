/**
 * Imports decision-makers from OD_REPREZENTANTI_LEGALI into `people`.
 *
 *   npm run import:reps -- --file od_reprezentanti_legali.csv --dry-run
 *   npm run import:reps -- --file od_reprezentanti_legali.csv
 *
 * Answers "who do I contact" for companies already imported. For a Romanian SRL
 * the `administrator` is usually the owner, which for this product's target
 * market is the person who signs off a purchase — from the official register,
 * at no cost, with no vendor.
 *
 * Only representatives of companies already in `companies` are imported: the
 * file covers the whole country and the slice is one county, so the join is
 * also the filter. Court-appointed roles are excluded, and so is every birth
 * and residence column — see src/lib/sources/onrc/representatives.ts for why.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { readRecords, sniffDelimiter, splitRow } from "../src/lib/sources/onrc/csv";
import { normaliseRegNumber } from "../src/lib/sources/onrc/join";
import {
  isDecisionMakerRole,
  isNaturalPerson,
  tidyName,
} from "../src/lib/sources/onrc/representatives";
import { classifySeniority } from "../src/lib/sources/people/seniority";
import { requireEnv } from "./load-env";

const WRITE_BATCH = 500;
const PAGE = 1000;

type Options = { file?: string; dryRun: boolean; limit?: number };

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--file":
        options.file = next();
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

async function* fileChunks(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of stream) yield chunk as string;
}

type Person = {
  company_id: string;
  full_name: string;
  title: string;
  seniority: string | null;
  source: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.file) {
    console.log(
      "Usage: npm run import:reps -- --file <OD_REPREZENTANTI_LEGALI.CSV> [--dry-run] [--limit n]",
    );
    process.exit(1);
  }
  try {
    await stat(options.file);
  } catch {
    console.error(`Cannot read ${options.file}`);
    process.exit(1);
  }

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // --- which companies do we have? ------------------------------------------
  // Paged: PostgREST caps a select at 1,000 rows and reports nothing.
  const byReg = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("companies")
      .select("id, reg_com")
      .not("reg_com", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }
    const page = (data ?? []) as { id: string; reg_com: string }[];
    for (const row of page) byReg.set(normaliseRegNumber(row.reg_com), row.id);
    if (page.length < PAGE) break;
  }

  if (byReg.size === 0) {
    console.error("No companies imported yet — run import:onrc first.");
    process.exit(1);
  }
  console.log(`${byReg.size} companies in scope\n`);

  // --- stream the representatives -------------------------------------------
  const counts = {
    read: 0,
    otherCompany: 0,
    wrongRole: 0,
    notAPerson: 0,
    duplicate: 0,
    kept: 0,
  };
  const seen = new Set<string>();
  const people: Person[] = [];

  let header: string[] | null = null;
  let delimiter = "^";
  const index: Record<string, number> = {};

  for await (const record of readRecords(fileChunks(options.file))) {
    if (record.trim() === "") continue;

    if (header === null) {
      delimiter = sniffDelimiter(record);
      header = splitRow(record, delimiter);
      header.forEach((cell, i) => {
        index[cell.trim().toUpperCase()] = i;
      });
      console.log(`Delimiter ${JSON.stringify(delimiter)}; columns: ${header.join(", ")}\n`);
      continue;
    }

    counts.read += 1;
    const fields = splitRow(record, delimiter);

    const companyId = byReg.get(
      normaliseRegNumber(fields[index.COD_INMATRICULARE ?? 0] ?? ""),
    );
    if (!companyId) {
      counts.otherCompany += 1;
      continue;
    }

    const role = (fields[index.CALITATE ?? 2] ?? "").trim();
    if (!isDecisionMakerRole(role)) {
      counts.wrongRole += 1;
      continue;
    }

    const rawName = (fields[index.PERSOANA_IMPUTERNICITA ?? 1] ?? "").trim();
    // Birth data is read to tell a person from a company and then discarded —
    // it is never written to the database.
    const hasBirthData = Boolean((fields[index.DATA_NASTERE ?? 3] ?? "").trim());
    if (!isNaturalPerson(rawName, hasBirthData)) {
      counts.notAPerson += 1;
      continue;
    }

    const fullName = tidyName(rawName);
    const key = `${companyId}:${fullName.toLowerCase()}`;
    if (seen.has(key)) {
      counts.duplicate += 1;
      continue;
    }
    seen.add(key);

    people.push({
      company_id: companyId,
      full_name: fullName,
      title: role,
      seniority: classifySeniority(role) ?? null,
      source: "onrc",
    });
    counts.kept += 1;

    if (options.limit && counts.kept >= options.limit) break;
  }

  console.log("Rows read:              ", counts.read);
  console.log("Not our companies:      ", counts.otherCompany);
  console.log("Court-appointed roles:  ", counts.wrongRole);
  console.log("Companies, not people:  ", counts.notAPerson);
  console.log("Duplicates:             ", counts.duplicate);
  console.log("Decision-makers kept:   ", counts.kept);

  const companiesCovered = new Set(people.map((person) => person.company_id)).size;
  console.log(
    `Companies with a contact: ${companiesCovered} of ${byReg.size} ` +
      `(${((companiesCovered / byReg.size) * 100).toFixed(0)}%)`,
  );

  if (people.length) {
    console.log("\nFirst 8:");
    for (const person of people.slice(0, 8)) {
      console.log(
        `  ${person.full_name.padEnd(32)} ${person.title.padEnd(22)} ${person.seniority ?? ""}`,
      );
    }
  }

  if (options.dryRun) {
    console.log("\nDry run — nothing was written.");
    return;
  }

  // --- write ----------------------------------------------------------------
  let written = 0;
  for (let i = 0; i < people.length; i += WRITE_BATCH) {
    const batch = people.slice(i, i + WRITE_BATCH);
    const { error } = await supabase.from("people").insert(batch);
    if (error) {
      console.error(`\nBatch at ${i} failed: ${error.message}`);
      console.error(`Wrote ${written} before failing.`);
      process.exit(1);
    }
    written += batch.length;
    process.stdout.write(`\r  writing: ${written}/${people.length}`);
  }
  console.log(`\n✓ Imported ${written} decision-makers`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
