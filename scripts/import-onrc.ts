/**
 * Imports the Romanian trade register into the `companies` table.
 *
 *   # always start here — no database, no config, writes nothing
 *   npm run import:onrc -- --file od_firme.csv --dry-run
 *
 *   # a real slice
 *   npm run import:onrc -- --file od_firme.csv --stare od_stare_firma.csv \
 *     --caen-file od_caen_autorizat.csv --nomenclator . --county CJ --active-only
 *
 * ONRC publishes several files that reference each other by trade-register
 * number, not by CUI:
 *
 *   OD_FIRME           690MB  the company: name, CUI, address, website
 *   OD_STARE_FIRMA      91MB  status codes — half the register is `radiată`
 *   OD_CAEN_AUTORIZAT    ?    authorised activity codes
 *   N_*                small  nomenclatures decoding those codes
 *
 * Nothing is held in memory except the slice being imported, and the order of
 * work is what keeps that true: filter OD_FIRME down to the wanted companies
 * first, then stream the other files keeping only rows that join to it. A
 * county is a few percent of the register, so the working set is tens of
 * thousands of rows rather than millions.
 *
 * This is also why `--county` or `--limit` is required for a real import: with
 * no filter the "slice" is the whole register, which neither fits in memory nor
 * in the 500MB Supabase free tier.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describeHeader, mapHeader, type ColumnMap } from "../src/lib/sources/onrc/columns";
import { parseCsv, readRecords, sniffDelimiter, splitRow } from "../src/lib/sources/onrc/csv";
import {
  buildCaenNomenclature,
  buildStatusNomenclature,
  caenKey,
  extractDomain,
  normaliseRegNumber,
  matchingCaen,
  principalCaen,
  resolveStatus,
  statusLabel,
  type CaenEntry,
} from "../src/lib/sources/onrc/join";
import { matchesFilter, parseRow, type RowFilter } from "../src/lib/sources/onrc/parse";
import type { SourcedCompany } from "../src/lib/sources/types";
import { readFileSync } from "node:fs";
import { requireEnv } from "./load-env";

const BATCH_SIZE = 500;
const SAMPLE_ROWS = 8;
const DRY_RUN_DEFAULT_ROWS = 2000;

type Options = {
  firme?: string;
  stare?: string;
  caenFile?: string;
  nomenclator?: string;
  dryRun: boolean;
  maxRows?: number;
  limit?: number;
  resume: number;
  filter: RowFilter;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, resume: 0, filter: {} };
  const list = (value: string) =>
    value.split(",").map((p) => p.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];

    switch (arg) {
      case "--file":
      case "--firme":
        options.firme = next();
        break;
      case "--stare":
        options.stare = next();
        break;
      case "--caen-file":
        options.caenFile = next();
        break;
      case "--nomenclator":
        options.nomenclator = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--max-rows":
        options.maxRows = Number(next());
        break;
      case "--limit":
        options.limit = Number(next());
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
      case "--has-website":
        options.filter.hasWebsite = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    "Usage: npm run import:onrc -- --file <OD_FIRME.CSV> [options]",
    "",
    "  --file <path>        OD_FIRME.CSV (required)",
    "  --stare <path>       OD_STARE_FIRMA.CSV — enables status; half the",
    "                       register is struck off, so this matters",
    "  --caen-file <path>   OD_CAEN_AUTORIZAT.CSV — enables industry targeting",
    "  --nomenclator <dir>  folder holding N_CAEN.CSV and N_STARE_FIRMA.CSV",
    "",
    "  --county <list>      county names or codes (CJ,TM,B)",
    "  --caen <list>        4-digit codes or 2-digit divisions",
    "  --active-only        skip companies the register marks as not trading",
    "  --limit <n>          stop after n matching companies",
    "  --max-rows <n>       stop after reading n rows of OD_FIRME",
    "  --resume <n>         skip the first n rows of OD_FIRME",
    "  --dry-run            report and write nothing (no database needed)",
    "",
    "Start with --dry-run. A real import needs --county or --limit.",
  ].join("\n");
}

async function* fileChunks(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of stream) yield chunk as string;
}

/** Read a small nomenclature file whole. These are a few hundred KB at most. */
function readNomenclature(dir: string, name: string): string[][] {
  try {
    return parseCsv(readFileSync(joinPath(dir, name), "utf8")).rows;
  } catch {
    return [];
  }
}

/** One company held in the working set, before the joins are applied. */
type Held = {
  company: SourcedCompany;
  regNumber: string;
  statusCodes: number[];
  caen: CaenEntry[];
};

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.firme) {
    console.log(usage());
    process.exit(1);
  }
  for (const [label, path] of [
    ["--file", options.firme],
    ["--stare", options.stare],
    ["--caen-file", options.caenFile],
  ] as const) {
    if (path) {
      try {
        await stat(path);
      } catch {
        console.error(`Cannot read ${label} at ${path}`);
        process.exit(1);
      }
    }
  }

  /*
   * A real import must be bounded. Without a filter the slice is the whole
   * register: 1.7M companies, which exceeds both memory and the free tier.
   *
   * `--has-website` bounds it as effectively as a county does, and far more
   * usefully: 11,050 of the 4.0M rows carry a usable website nationally, about
   * 5,600 of them still trading. That is the densest slice in the file — a
   * domain is the one input the email pipeline cannot work without, and 26% of
   * companies that have one publish a role address.
   */
  const bounded =
    Boolean(options.filter.county?.length) ||
    Boolean(options.limit) ||
    Boolean(options.filter.hasWebsite);

  if (!options.dryRun && !bounded) {
    console.error(
      "Refusing to import the whole register.\n" +
        "Pass --county (e.g. --county CJ), --has-website, or --limit.\n" +
        "See docs/STATUS.md: the free tier is 500MB and the full register" + 
        " would not fit.",
    );
    process.exit(1);
  }

  const maxRows =
    options.maxRows ?? (options.dryRun ? DRY_RUN_DEFAULT_ROWS : undefined);

  // --- nomenclatures ---------------------------------------------------------
  const dir = options.nomenclator;
  const statusNames = dir
    ? buildStatusNomenclature(readNomenclature(dir, "n_stare_firma.csv"))
    : new Map<number, string>();
  const caenNames = dir
    ? buildCaenNomenclature(readNomenclature(dir, "n_caen.csv"))
    : new Map();
  if (dir) {
    console.log(
      `Nomenclatures: ${statusNames.size} status codes, ${caenNames.size} CAEN codes\n`,
    );
  }

  // --- pass A: the companies -------------------------------------------------
  console.log(`Reading ${options.firme}${options.dryRun ? " (dry run)" : ""}`);

  const held = new Map<string, Held>();
  const counts = {
    read: 0,
    matched: 0,
    filtered: 0,
    missing_cui: 0,
    invalid_cui: 0,
    missing_name: 0,
    withWebsite: 0,
  };

  let header: string[] | null = null;
  let delimiter = "^";
  let map: ColumnMap = {};

  for await (const record of readRecords(fileChunks(options.firme))) {
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

    const fields = splitRow(record, delimiter);
    const parsed = parseRow(fields, map);
    if (!parsed.ok) {
      counts[parsed.reason] += 1;
      continue;
    }

    // County is the only filter applicable before the joins; CAEN and status
    // arrive from the other files and are applied at the end.
    if (!matchesFilter(parsed.company, undefined, { county: options.filter.county })) {
      counts.filtered += 1;
      continue;
    }

    const websiteIndex = map.website;
    if (websiteIndex !== undefined) {
      const domain = extractDomain(fields[websiteIndex] ?? "");
      if (domain) {
        parsed.company.domain = domain;
        parsed.company.website = `https://${domain}`;
        counts.withWebsite += 1;
      }
    }

    /*
     * `--has-website` is applied here rather than with the other filters at the
     * end, for two reasons. The domain only exists after the extraction just
     * above — the raw column carries phone numbers, so the parsed `domain` is
     * the honest test, not the raw cell. And a national pass would otherwise
     * hold four million companies in `held` to discard all but eleven thousand
     * of them; filtering in the scan keeps memory proportional to the slice.
     */
    if (options.filter.hasWebsite && !parsed.company.domain) {
      counts.filtered += 1;
      continue;
    }

    const regNumber = normaliseRegNumber(parsed.company.regCom ?? "");
    if (regNumber) {
      held.set(regNumber, {
        company: parsed.company,
        regNumber,
        statusCodes: [],
        caen: [],
      });
    }
    counts.matched += 1;

    if (options.limit && counts.matched >= options.limit) break;
    if (maxRows && counts.read >= maxRows) break;
  }

  console.log(`Held ${held.size} companies from ${counts.read} rows read\n`);

  // --- pass B: status --------------------------------------------------------
  if (options.stare && held.size > 0) {
    console.log(`Joining status from ${options.stare}…`);
    let statusHeader: string[] | null = null;
    let statusDelimiter = "^";
    let joined = 0;

    for await (const record of readRecords(fileChunks(options.stare))) {
      if (record.trim() === "") continue;
      if (statusHeader === null) {
        statusDelimiter = sniffDelimiter(record);
        statusHeader = splitRow(record, statusDelimiter);
        continue;
      }
      const [reg, code] = splitRow(record, statusDelimiter);
      const entry = held.get(normaliseRegNumber(reg ?? ""));
      if (!entry) continue;
      const parsedCode = Number((code ?? "").trim());
      if (Number.isFinite(parsedCode)) {
        entry.statusCodes.push(parsedCode);
        joined += 1;
      }
    }
    console.log(`  ${joined} status rows matched\n`);
  }

  // --- pass C: CAEN ----------------------------------------------------------
  if (options.caenFile && held.size > 0) {
    console.log(`Joining CAEN from ${options.caenFile}…`);
    let caenHeader: string[] | null = null;
    let caenDelimiter = "^";
    const caenMap: Record<string, number> = {};
    let joined = 0;

    for await (const record of readRecords(fileChunks(options.caenFile))) {
      if (record.trim() === "") continue;
      if (caenHeader === null) {
        caenDelimiter = sniffDelimiter(record);
        caenHeader = splitRow(record, caenDelimiter);
        // The layout of this file has not been observed; locate the columns we
        // need by name rather than assuming positions.
        caenHeader.forEach((cell, i) => {
          const key = cell.trim().toUpperCase();
          caenMap[key] = i;
        });
        console.log(`  columns: ${caenHeader.join(", ")}`);
        continue;
      }
      const fields = splitRow(record, caenDelimiter);
      const reg = fields[caenMap.COD_INMATRICULARE ?? 0] ?? "";
      const entry = held.get(normaliseRegNumber(reg));
      if (!entry) continue;

      // Real header: COD_INMATRICULARE^COD_CAEN_AUTORIZAT^VER_CAEN_AUTORIZAT.
      // There is no principal-activity flag — the file lists every authorised
      // code, 4.8 per company on average.
      const codeIndex =
        caenMap.COD_CAEN_AUTORIZAT ?? caenMap.COD_CAEN ?? caenMap.CAEN ?? 1;
      const versionIndex =
        caenMap.VER_CAEN_AUTORIZAT ?? caenMap.VERSIUNE_CAEN ?? -1;
      const version = Number((fields[versionIndex] ?? "").trim());
      entry.caen.push({
        code: (fields[codeIndex] ?? "").trim(),
        version: Number.isFinite(version) ? version : 0,
        principal: false,
      });
      joined += 1;
    }
    console.log(`  ${joined} CAEN rows matched\n`);
  }

  // --- apply the joins and the remaining filters ------------------------------
  const ready: { company: SourcedCompany; onrcStatus?: string }[] = [];
  let droppedInactive = 0;
  let droppedCaen = 0;

  for (const entry of held.values()) {
    const verdict = resolveStatus(entry.statusCodes);
    const label = statusLabel(entry.statusCodes, statusNames);

    if (options.filter.activeOnly && verdict.trading === false) {
      droppedInactive += 1;
      continue;
    }

    // Filter on *any* authorised activity, then store the code that explains
    // the match — showing an unrelated code next to a matched company would
    // make the targeting look broken.
    const wanted = options.filter.caen ?? [];
    const chosen = wanted.length
      ? matchingCaen(entry.caen, wanted)
      : principalCaen(entry.caen);

    if (wanted.length && !chosen) {
      droppedCaen += 1;
      continue;
    }
    if (chosen) {
      entry.company.caen = chosen.code;
      entry.company.caenLabel =
        caenNames.get(caenKey(chosen.code, chosen.version))?.label;
    }

    ready.push({ company: entry.company, onrcStatus: label });
  }

  // --- report ----------------------------------------------------------------
  console.log("Rows read from OD_FIRME:", counts.read);
  console.log("Matched the county filter:", counts.matched);
  console.log("With a website:", counts.withWebsite);
  console.log("Dropped — not trading:", droppedInactive);
  console.log("Dropped — CAEN filter:", droppedCaen);
  const rejected = counts.missing_cui + counts.invalid_cui + counts.missing_name;
  console.log(
    `Rejected: ${rejected}` +
      (rejected
        ? ` (no cui ${counts.missing_cui}, bad cui ${counts.invalid_cui}, no name ${counts.missing_name})`
        : ""),
  );
  console.log("Ready to import:", ready.length);

  if (counts.read > 0 && rejected / counts.read > 0.2) {
    console.log(
      "\nOver a fifth of rows were rejected. Check the column mapping above " +
        "before trusting this run.",
    );
  }

  if (ready.length) {
    console.log(`\nFirst ${Math.min(SAMPLE_ROWS, ready.length)}:`);
    for (const { company, onrcStatus } of ready.slice(0, SAMPLE_ROWS)) {
      console.log(
        `  ${(company.cui ?? "").padEnd(10)} ${company.name.slice(0, 34).padEnd(36)} ` +
          `${(company.caen ?? "----").padEnd(5)} ${(company.county ?? "").padEnd(12)} ` +
          `${(company.domain ?? "").padEnd(24)} ${onrcStatus ?? ""}`,
      );
    }
  }

  if (options.dryRun) {
    const partial = maxRows !== undefined && counts.read >= maxRows;
    console.log(
      `\nDry run — nothing was written.${
        partial ? ` Counts cover the first ${maxRows} rows, not the file.` : ""
      }`,
    );
    return;
  }

  // --- write -----------------------------------------------------------------
  await writeAll(ready);
}

/**
 * Upsert the slice.
 *
 * Through the **service role**: `companies` is shared reference data rather
 * than tenant rows — it is public registry information, cached once for
 * everyone — and this is a script with no user session. `cui` is the conflict
 * target because it is the register's own unique key and the table has a unique
 * index on it, so re-running is idempotent rather than duplicating.
 */
async function writeAll(
  ready: { company: SourcedCompany; onrcStatus?: string }[],
): Promise<void> {
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  await dropConflictingDomains(supabase, ready);

  let written = 0;
  for (let i = 0; i < ready.length; i += BATCH_SIZE) {
    const batch = ready.slice(i, i + BATCH_SIZE).map(({ company, onrcStatus }) => ({
      cui: company.cui,
      name: company.name,
      domain: company.domain ?? null,
      website: company.website ?? null,
      country: company.country ?? "RO",
      county: company.county ?? null,
      city: company.city ?? null,
      reg_com: company.regCom ?? null,
      caen: company.caen ?? null,
      caen_label: company.caenLabel ?? null,
      onrc_status: onrcStatus ?? null,
      registration_date: company.registrationDate ?? null,
      source: company.source,
    }));

    const { error } = await supabase
      .from("companies")
      .upsert(batch, { onConflict: "cui", ignoreDuplicates: false });

    if (error) {
      console.error(`\nBatch at ${i} failed: ${error.message}`);
      console.error(`Wrote ${written} before failing. Re-running is safe —`);
      console.error("the upsert is keyed on cui, so nothing duplicates.");
      process.exit(1);
    }
    written += batch.length;
    process.stdout.write(`\r  wrote ${written}/${ready.length}`);
  }
  console.log(`\n✓ Imported ${written} companies`);
}

/**
 * Keep `companies.domain` unique, because the schema says it must be.
 *
 * `companies_domain_idx` is a unique index — domain is a deduplication key, so
 * that is correct. The register disagrees: Romanian groups routinely run
 * several legal entities off one website, and a handful of registrations share
 * a hosting company's placeholder. Upserting on `cui` therefore fails on the
 * *domain* constraint as soon as the second company claiming a site arrives.
 *
 * The domain goes to whichever company gets there first, and the rest keep
 * their registry data with `domain` null. Dropping the constraint instead would
 * be worse: it exists so that a crawler and a registry import can recognise the
 * same company, and a duplicated domain quietly breaks that.
 */
async function dropConflictingDomains(
  supabase: SupabaseClient,
  ready: { company: SourcedCompany; onrcStatus?: string }[],
): Promise<void> {
  const seen = new Set<string>();
  let withinRun = 0;

  for (const { company } of ready) {
    if (!company.domain) continue;
    if (seen.has(company.domain)) {
      company.domain = undefined;
      company.website = undefined;
      withinRun += 1;
    } else {
      seen.add(company.domain);
    }
  }

  // Also yield to a domain already held by a different company from an earlier
  // run, which a within-run check alone would not catch.
  let acrossRuns = 0;
  const domains = [...seen];
  for (let i = 0; i < domains.length; i += 200) {
    const slice = domains.slice(i, i + 200);
    const { data } = await supabase
      .from("companies")
      .select("cui, domain")
      .in("domain", slice);

    const owner = new Map(
      (data ?? []).map((row) => [
        (row as { domain: string }).domain,
        (row as { cui: string | null }).cui,
      ]),
    );
    for (const { company } of ready) {
      if (!company.domain) continue;
      const existing = owner.get(company.domain);
      if (existing !== undefined && existing !== company.cui) {
        company.domain = undefined;
        company.website = undefined;
        acrossRuns += 1;
      }
    }
  }

  if (withinRun || acrossRuns) {
    console.log(
      `Domains released to their first claimant: ${withinRun} within this run` +
        (acrossRuns ? `, ${acrossRuns} already held` : ""),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
