/**
 * Expands the industry prefixes in `industry-definitions.ts` into real CAEN
 * class codes, against the official ONRC nomenclator.
 *
 *   npm run build:industries -- --file ~/Downloads/n_caen.csv
 *   npm run build:industries -- --file ~/Downloads/n_caen.csv --check
 *
 * Why generate rather than hand-write the codes: the register mixes CAEN 2008
 * (NACE Rev. 2, what ANAF files) and CAEN 2025 (NACE Rev. 2.1, what ONRC now
 * lists), and the 2025 revision renumbered heavily. `companies.caen` holds both
 * spellings today — 2,263 rows on 6201 and 2,714 on 6210, the same activity.
 * Writing "62" once and expanding it per revision is the only way to stay
 * correct as the register drifts.
 *
 * `--check` regenerates in memory and fails if the committed file differs,
 * which is what CI should run. The nomenclator is a 3,700-line CSV from
 * data.gov.ro and is not in the repo.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { INDUSTRY_DEFINITIONS } from "../src/lib/icp/industry-definitions";

const OUTPUT = "src/lib/icp/nace-codes.generated.ts";

/** Revisions live in `companies.caen` today. 0 (1998) and 1 (2003) are dead. */
const LIVE_REVISIONS = new Set(["2", "3"]);
const REVISION_LABELS: Record<string, string> = { "2": "CAEN 2008", "3": "CAEN 2025" };

type Options = { file: string; check: boolean };

function parseArgs(argv: string[]): Options {
  const options: Options = { file: "", check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--file":
        options.file = next();
        break;
      case "--check":
        options.check = true;
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (!options.file) throw new Error("--file <n_caen.csv> is required");
  return options;
}

type NaceClass = { code: string; label: string; revision: string };

/**
 * The nomenclator is `^`-delimited with a UTF-8 BOM, like every other ONRC
 * export. Rows carrying no CLASA are section, division or group headings —
 * real rows, but not targetable, since `companies.caen` always holds a class.
 */
function readNomenclator(path: string): NaceClass[] {
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

  const classes: NaceClass[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split("^");
    const code = (parts[classAt] ?? "").trim();
    const revision = (parts[revisionAt] ?? "").trim();
    if (!/^\d{4}$/.test(code) || !LIVE_REVISIONS.has(revision)) continue;
    classes.push({ code, label: (parts[labelAt] ?? "").trim(), revision });
  }
  return classes;
}

type Claim = { prefix: string; revision?: string };

/** `"4791@2"` → claim the exact class, in CAEN 2008 only. */
function parseClaim(raw: string): Claim {
  const [prefix, revision] = raw.split("@");
  if (revision && !LIVE_REVISIONS.has(revision)) {
    throw new Error(`Unknown revision in "${raw}" — live revisions are ${[...LIVE_REVISIONS]}`);
  }
  return { prefix, revision };
}

function matches(entry: NaceClass, claim: Claim): boolean {
  if (claim.revision && entry.revision !== claim.revision) return false;
  // A 4-digit prefix is an exact class; anything shorter is a division or group.
  return claim.prefix.length === 4
    ? entry.code === claim.prefix
    : entry.code.startsWith(claim.prefix);
}

type Built = {
  codesByIndustry: Map<string, string[]>;
  labels: Map<string, string>;
  conflicts: { code: string; keys: string[]; meanings: string[] }[];
  drifted: { code: string; meanings: string[] }[];
  unmatchedPrefixes: { key: string; prefix: string }[];
};

function build(classes: NaceClass[]): Built {
  /*
   * Claims are collected with the length of the prefix that made them, because
   * the specific claim has to beat the general one. `retail` takes the whole of
   * division 47 and `ecommerce` takes the single class 4791 out of it — that is
   * a deliberate nesting, not a collision, and resolving it by prefix length
   * means a new specific industry never has to be subtracted by hand from every
   * broad one above it.
   */
  const claims = new Map<string, { key: string; specificity: number }[]>();
  const labels = new Map<string, string>();
  const unmatchedPrefixes: { key: string; prefix: string }[] = [];

  for (const industry of INDUSTRY_DEFINITIONS) {
    for (const raw of industry.nace) {
      const claim = parseClaim(raw);
      const hits = classes.filter((entry) => matches(entry, claim));
      if (hits.length === 0) unmatchedPrefixes.push({ key: industry.key, prefix: raw });

      for (const hit of hits) {
        const owners = claims.get(hit.code) ?? [];
        owners.push({ key: industry.key, specificity: claim.prefix.length });
        claims.set(hit.code, owners);
        // Prefer the newest revision's wording — it is what a company
        // registering today files under.
        if (hit.revision === "3" || !labels.has(hit.code)) labels.set(hit.code, hit.label);
      }
    }
  }

  const meaningsOf = (code: string) => [
    ...new Set(
      classes
        .filter((entry) => entry.code === code)
        .map((entry) => `${REVISION_LABELS[entry.revision]}: ${entry.label}`),
    ),
  ];

  /*
   * A conflict here is two industries claiming one code *at the same
   * specificity* — a definition bug, not a data problem, and it is dropped from
   * both rather than silently assigned to whichever was declared first.
   *
   * Note what this deliberately cannot catch. Industries are keyed on division,
   * and a code's division never changes between revisions, so a code whose
   * *meaning* moved while its number stayed put still lands in the same
   * industry. That is usually right — `2051` went from explosives to liquid
   * biofuels and both are chemicals — but it is why the `drifted` report below
   * exists for anything pinned to an exact class.
   */
  const drifted: Built["drifted"] = [];
  const conflicts: Built["conflicts"] = [];
  const codesByIndustry = new Map<string, string[]>();
  for (const industry of INDUSTRY_DEFINITIONS) codesByIndustry.set(industry.key, []);

  for (const [code, owners] of claims) {
    const best = Math.max(...owners.map((owner) => owner.specificity));
    const winners = [...new Set(owners.filter((o) => o.specificity === best).map((o) => o.key))];

    if (winners.length > 1) {
      conflicts.push({ code, keys: winners.sort(), meanings: meaningsOf(code) });
      continue;
    }
    codesByIndustry.get(winners[0])!.push(code);
  }

  /*
   * Reported but not excluded: an exact-code claim whose meaning changed
   * between revisions. `ecommerce` claims `4791@2` precisely because of this —
   * the author saw both meanings and scoped the claim. Printing it every run is
   * what makes the next such change visible instead of silent.
   */
  for (const [code, owners] of claims) {
    const declaredExact = owners.some((owner) => owner.specificity === 4);
    if (!declaredExact) continue;
    const meanings = meaningsOf(code);
    if (meanings.length > 1) drifted.push({ code, meanings });
  }

  for (const codes of codesByIndustry.values()) codes.sort();
  return { codesByIndustry, labels, conflicts, drifted, unmatchedPrefixes };
}

function render(built: Built, sourceHash: string): string {
  const industries = [...built.codesByIndustry.entries()]
    .map(([key, codes]) => {
      const lines = codes.map((code) => `    "${code}",`).join("\n");
      return `  ${key}: [\n${lines}\n  ],`;
    })
    .join("\n");

  const usedCodes = new Set([...built.codesByIndustry.values()].flat());
  const labels = [...built.labels.entries()]
    .filter(([code]) => usedCodes.has(code))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, label]) => `  "${code}": ${JSON.stringify(label)},`)
    .join("\n");

  const conflicts = built.conflicts
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(
      (conflict) =>
        `  // ${conflict.meanings.join("  |  ")}\n` +
        `  { code: "${conflict.code}", industries: ${JSON.stringify(conflict.keys)} },`,
    )
    .join("\n");

  return `/**
 * GENERATED by \`npm run build:industries\`. Do not edit.
 *
 * Source: ONRC \`n_caen.csv\` (sha256 ${sourceHash.slice(0, 16)}), classes from
 * CAEN 2008 (NACE Rev. 2) and CAEN 2025 (NACE Rev. 2.1) only. Both are live in
 * \`companies.caen\`, which is why an industry carries codes from each.
 *
 * Edit the prefixes in \`industry-definitions.ts\` and re-run instead.
 */

/** 4-digit CAEN classes per industry key, across every live revision. */
export const INDUSTRY_NACE_CODES: Record<string, readonly string[]> = {
${industries}
};

/** Romanian label per code, from the newest revision that defines it. */
export const NACE_LABELS: Record<string, string> = {
${labels}
};

/**
 * Codes that mean different things in different revisions.
 *
 * Excluded from every industry above. \`companies.caen\` does not record which
 * revision a row was filed under, so targeting one of these would silently
 * include the other meaning.
 */
export const NACE_CONFLICTS: readonly { code: string; industries: readonly string[] }[] = [
${conflicts}
];
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = readFileSync(options.file);
  const sourceHash = createHash("sha256").update(raw).digest("hex");

  const classes = readNomenclator(options.file);
  const revisions = new Map<string, number>();
  for (const entry of classes) {
    revisions.set(entry.revision, (revisions.get(entry.revision) ?? 0) + 1);
  }

  const built = build(classes);
  const rendered = render(built, sourceHash);

  console.log(
    `${classes.length} classes read (` +
      [...revisions.entries()]
        .sort()
        .map(([revision, n]) => `${REVISION_LABELS[revision]}: ${n}`)
        .join(", ") +
      `)\n${INDUSTRY_DEFINITIONS.length} industries\n`,
  );

  for (const [key, codes] of built.codesByIndustry) {
    const flag = codes.length === 0 ? "  <-- EMPTY" : "";
    console.log(`  ${key.padEnd(26)} ${String(codes.length).padStart(3)} codes${flag}`);
  }

  if (built.unmatchedPrefixes.length > 0) {
    console.log("\nPrefixes that matched no class — a typo, or a division that no longer exists:");
    for (const { key, prefix } of built.unmatchedPrefixes) console.log(`  ${key}: ${prefix}`);
  }

  if (built.conflicts.length > 0) {
    console.log(
      `\n${built.conflicts.length} codes claimed by two industries at the same ` +
        `specificity, excluded from both — fix the definitions:`,
    );
    for (const conflict of built.conflicts) {
      console.log(`  ${conflict.code}  ${conflict.keys.join(" vs ")}`);
      for (const meaning of conflict.meanings) console.log(`      ${meaning}`);
    }
  }

  if (built.drifted.length > 0) {
    console.log(
      `\n${built.drifted.length} exactly-pinned codes mean different things in ` +
        `different revisions. Check each claim is still scoped correctly:`,
    );
    for (const entry of built.drifted) {
      console.log(`  ${entry.code}`);
      for (const meaning of entry.meanings) console.log(`      ${meaning}`);
    }
  }

  if (options.check) {
    const existing = readFileSync(OUTPUT, "utf8");
    if (existing !== rendered) {
      console.error(`\n${OUTPUT} is out of date. Re-run without --check.`);
      process.exit(1);
    }
    console.log(`\n${OUTPUT} is up to date.`);
    return;
  }

  writeFileSync(OUTPUT, rendered);
  console.log(`\nWrote ${OUTPUT}`);
}

main();
