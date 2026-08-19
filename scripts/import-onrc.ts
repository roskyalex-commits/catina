/**
 * Imports the Romanian trade register CSV into the `companies` table.
 *
 *   npm run import:onrc -- --file data/onrc.csv --dry-run
 *   npm run import:onrc -- --file data/onrc.csv --county CJ --caen 62 --max-rows 5000
 *   npm run import:onrc -- --file data/onrc.csv --resume 240000
 *
 * The file comes from data.gov.ro and has never been observed by anyone who
 * worked on this code (docs/STATUS.md). Two consequences shape the script:
 *
 *   1. `--dry-run` needs no database and no configuration. It reads the header,
 *      prints which column it matched to which field, parses a sample and shows
 *      the companies that came out. Run it first, every time. If a column is
 *      named something unexpected, the fix is one string in
 *      `ONRC_COLUMN_ALIASES` — nothing downstream knows about CSV columns.
 *   2. Nothing is held in memory. The register is ~4M rows and the free
 *      Supabase tier is 500MB, which is also why importing a narrow slice
 *      (`--county`, `--caen`) is the intended path rather than the whole file.
 *
 * A row that fails to parse is counted and skipped, never guessed at. The tally
 * is printed at the end, because a run that silently drops a third of the file
 * should look different from one that does not.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { describeHeader, mapHeader } from "../src/lib/sources/onrc/columns";
import { readRecords, sniffDelimiter, splitRow } from "../src/lib/sources/onrc/csv";
import {
  matchesFilter,
  parseRow,
  type RowFilter,
} from "../src/lib/sources/onrc/parse";
import type { SourcedCompany } from "../src/lib/sources/types";

const BATCH_SIZE = 500;
const SAMPLE_ROWS = 5;
/** Rows a dry run reads before reporting, unless --max-rows says otherwise. */
const DRY_RUN_DEFAULT_ROWS = 1000;

type Options = {
  file?: string;
  dryRun: boolean;
  maxRows?: number;
  resume: number;
  filter: RowFilter;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, resume: 0, filter: {} };
  const list = (value: string) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];

    switch (arg) {
      case "--file":
        options.file = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--max-rows":
        options.maxRows = Number(next());
        break;
      case "--resume":
        options.resume = Number(next());
        break;
      case "--caen":
        options.filter.caen = list(next());
        break;
      case "--county":
        options.filter.county = list(next());
        break;
      case "--active-only":
        options.filter.activeOnly = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }
  return options;
}

function usage(): string {
  return [
    "Usage: npm run import:onrc -- --file <path.csv> [options]",
    "",
    "  --file <path>       the ONRC CSV from data.gov.ro (required)",
    "  --dry-run           report the header and a parsed sample, write nothing",
    "  --max-rows <n>      stop after n data rows",
    "  --resume <n>        skip the first n data rows",
    "  --caen <list>       4-digit codes or 2-digit divisions, comma separated",
    "  --county <list>     county names or registration codes (CJ,TM,B)",
    "  --active-only       skip companies the register marks as not trading",
    "",
    "Start with --dry-run. It needs no database and no .env.local.",
  ].join("\n");
}

/** Line-by-line reader that keeps memory flat regardless of file size. */
async function* fileChunks(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of stream) yield chunk as string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.file) {
    console.log(usage());
    process.exit(1);
  }

  try {
    await stat(options.file);
  } catch {
    console.error(`Cannot read ${options.file}`);
    process.exit(1);
  }

  /**
   * A dry run stops early by default. The register is ~4M rows, and reading all
   * of them to learn that column 3 is CAEN wastes several minutes. The counts
   * are then labelled as a sample rather than a total, so a partial read cannot
   * be mistaken for the whole file.
   */
  const maxRows =
    options.maxRows ?? (options.dryRun ? DRY_RUN_DEFAULT_ROWS : undefined);

  console.log(`Reading ${options.file}${options.dryRun ? " (dry run)" : ""}\n`);

  let header: string[] | null = null;
  let delimiter = ";";
  let map: ReturnType<typeof mapHeader>["map"] = {};

  const counts = {
    read: 0,
    imported: 0,
    filtered: 0,
    missing_cui: 0,
    invalid_cui: 0,
    missing_name: 0,
  };
  const sample: SourcedCompany[] = [];
  let batch: { company: SourcedCompany; status?: string }[] = [];

  for await (const record of readRecords(fileChunks(options.file))) {
    if (record.trim() === "") continue;

    if (header === null) {
      delimiter = sniffDelimiter(record);
      header = splitRow(record, delimiter);
      const report = mapHeader(header);
      map = report.map;

      console.log(`Delimiter: ${JSON.stringify(delimiter)}`);
      console.log(describeHeader(header, report));
      console.log();

      if (!report.usable) process.exit(1);
      continue;
    }

    counts.read += 1;
    if (counts.read <= options.resume) continue;

    const parsed = parseRow(splitRow(record, delimiter), map);
    if (!parsed.ok) {
      counts[parsed.reason] += 1;
      continue;
    }

    if (!matchesFilter(parsed.company, parsed.status, options.filter)) {
      counts.filtered += 1;
      continue;
    }

    counts.imported += 1;
    if (sample.length < SAMPLE_ROWS) sample.push(parsed.company);

    if (!options.dryRun) {
      batch.push({ company: parsed.company, status: parsed.status });
      if (batch.length >= BATCH_SIZE) {
        await writeBatch(batch);
        batch = [];
      }
    }

    if (maxRows && counts.imported >= maxRows) break;
  }

  if (!options.dryRun && batch.length) await writeBatch(batch);

  if (sample.length) {
    console.log(`First ${sample.length} parsed:`);
    for (const company of sample) {
      console.log(
        `  ${company.cui?.padEnd(10)} ${company.name.slice(0, 38).padEnd(40)} ` +
          `${(company.caen ?? "----").padEnd(5)} ${company.county ?? ""}`,
      );
    }
    console.log();
  }

  console.log("Rows read:      ", counts.read);
  console.log("Would import:   ", counts.imported);
  console.log("Filtered out:   ", counts.filtered);
  const rejected = counts.missing_cui + counts.invalid_cui + counts.missing_name;
  console.log(
    `Rejected:        ${rejected}` +
      (rejected
        ? ` (no cui ${counts.missing_cui}, bad cui ${counts.invalid_cui}, no name ${counts.missing_name})`
        : ""),
  );

  // A high rejection rate almost always means a column mapped to the wrong
  // field, not that the register is full of bad rows.
  if (counts.read > 0 && rejected / counts.read > 0.2) {
    console.log(
      "\nOver a fifth of rows were rejected. Check the column mapping above " +
        "before trusting this run.",
    );
  }

  if (options.dryRun) {
    const partial = maxRows !== undefined && counts.read >= maxRows;
    console.log(
      `\nDry run — nothing was written.${
        partial ? ` Counts cover the first ${maxRows} rows, not the file.` : ""
      }`,
    );
  }
}

/**
 * Persist a batch.
 *
 * Deliberately unimplemented: no database exists yet (step 1 in
 * docs/STATUS.md), and a write path that has never run against a real table is
 * not worth guessing at. Everything above this line — read, map, parse, filter,
 * report — works today and is covered by tests.
 *
 * When the database lands this becomes an upsert on `companies` keyed by `cui`,
 * through the **service-role** client: `companies` is shared reference data
 * rather than tenant rows, and this is a script with no user session.
 */
async function writeBatch(
  batch: { company: SourcedCompany; status?: string }[],
): Promise<void> {
  throw new Error(
    `Cannot write ${batch.length} companies: the database is not set up yet.\n` +
      "Run with --dry-run, or complete step 1 in docs/STATUS.md first.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
