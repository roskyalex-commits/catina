/**
 * Derives a Romanian given-name lexicon from the names we already hold.
 *
 *   npm run build:given-names
 *   npm run build:given-names -- --check
 *
 * ## Why a lexicon at all
 *
 * ONRC writes names surname-first — `Podar Simona Mihaela` is Simona Podar —
 * while every vendor and every team page writes them given-first. To build
 * `simona.podar@` rather than `podar.mihaela@`, something has to know which
 * token is which, and the register does not say: `OD_REPREZENTANTI_LEGALI` has
 * one `NUME` column, not two.
 *
 * ## Why derive rather than ship a list
 *
 * A downloaded list of Romanian forenames would miss the Hungarian and German
 * names common in Transylvania, which is where most of the current import comes
 * from — `Tussay Szilard` is surname-first too, and a Romanian-only list would
 * call both halves unknown. The register itself is the better dictionary: with
 * ~30,000 names in a fixed order, a token's *position* is the evidence.
 *
 * Surnames cluster in position 1, given names in position 2+. Measured on the
 * 29,551 names present when this was written: of tokens seen 5+ times, 735 are
 * given-name-like, 1,076 surname-like, and 192 genuinely ambiguous — `radu`
 * lands in the ambiguous bucket, correctly, because it is both a surname and a
 * given name.
 *
 * ## What this cannot do
 *
 * It learns the register's convention, not the truth. If a future import writes
 * names given-first, the tallies inverte and the lexicon is silently wrong. The
 * regeneration report prints the head of each list precisely so a reader can
 * see at a glance that `pop` and `muresan` are on the surname side; if that
 * ever flips, stop and check the importer rather than committing the output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";

const OUTPUT = "src/lib/enrichment/given-names.generated.ts";
const PAGE = 1000;

/**
 * A token has to appear this often before its position is evidence rather than
 * coincidence. At 5, a name seen once contributes nothing and a typo in the
 * register cannot reach the lexicon.
 */
const MIN_OCCURRENCES = 5;
/** Share of appearances in position 2+ above which a token is a given name. */
const GIVEN_THRESHOLD = 0.85;
/** ...and below which it is a surname. Between the two is ambiguous, and unused. */
const SURNAME_THRESHOLD = 0.15;

type Options = { check: boolean };

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false };
  for (const arg of argv) {
    if (arg === "--check") options.check = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
  }
  return options;
}

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/**
 * Fold to the letters that can appear in an email local part.
 *
 * Deliberately the same transformation as `slugifyName` in `patterns.ts`: the
 * lexicon is built from slugified tokens and looked up with slugified tokens,
 * so any divergence between the two would make entries unfindable.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

type Tally = { first: number; rest: number };

async function readNames(): Promise<string[]> {
  const names: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("people")
      .select("full_name")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`people: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) names.push(row.full_name as string);
    if (data.length < PAGE) break;
  }
  return names;
}

function tally(names: string[]): Map<string, Tally> {
  const counts = new Map<string, Tally>();
  const bump = (token: string, slot: keyof Tally) => {
    const entry = counts.get(token) ?? { first: 0, rest: 0 };
    entry[slot] += 1;
    counts.set(token, entry);
  };

  for (const name of names) {
    const tokens = name
      .split(/\s+/)
      /*
       * Hyphens are separators, not letters. `Dan-Alexandru` is two given
       * names, and folding it whole taught the lexicon `danalexandru` — an
       * entry that matches exactly one person and leaves `dan` and `alexandru`
       * each one sighting poorer. Romanian compound given names are common
       * enough that this measurably changed how much of the corpus the lexicon
       * can classify.
       */
      .flatMap((word) => word.split(/[-‐‑–—]/))
      .map(fold)
      // Single letters are patronymic initials — `Chertes L Liviu`. They are
      // never a name, and counting them would dominate the given-name side.
      .filter((token) => token.length > 1);
    if (tokens.length < 2) continue;

    bump(tokens[0], "first");
    for (const token of tokens.slice(1)) bump(token, "rest");
  }
  return counts;
}

type Built = {
  given: string[];
  surnames: string[];
  ambiguous: string[];
  namesRead: number;
};

function build(names: string[]): Built {
  const counts = tally(names);
  const given: string[] = [];
  const surnames: string[] = [];
  const ambiguous: string[] = [];

  for (const [token, entry] of counts) {
    const total = entry.first + entry.rest;
    if (total < MIN_OCCURRENCES) continue;

    const share = entry.rest / total;
    if (share >= GIVEN_THRESHOLD) given.push(token);
    else if (share <= SURNAME_THRESHOLD) surnames.push(token);
    else ambiguous.push(token);
  }

  return {
    given: given.sort(),
    surnames: surnames.sort(),
    ambiguous: ambiguous.sort(),
    namesRead: names.length,
  };
}

/**
 * Wrapped at a readable width rather than one token per line: these lists run
 * to four figures, and a reviewer scans them rather than reading them.
 */
function renderSet(tokens: string[]): string {
  const lines: string[] = [];
  let line = " ";
  for (const token of tokens) {
    const piece = ` "${token}",`;
    if (line.length + piece.length > 78) {
      lines.push(line);
      line = " ";
    }
    line += piece;
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}

function render(built: Built): string {
  const givenPct = Math.round(GIVEN_THRESHOLD * 100);
  const surnamePct = Math.round(SURNAME_THRESHOLD * 100);

  return `/**
 * GENERATED by \`npm run build:given-names\`. Do not edit.
 *
 * Derived from ${built.namesRead.toLocaleString("en-US")} names in \`people.full_name\`, which the ONRC
 * import writes surname-first. A token counts as a given name when at least
 * ${givenPct}% of its appearances are in position 2 or later, and as a surname when at
 * most ${surnamePct}% are. Tokens seen fewer than ${MIN_OCCURRENCES} times are excluded entirely.
 *
 * ${built.ambiguous.length} tokens fell between the two thresholds and are in neither set —
 * \`radu\` is the archetype, being both a surname and a given name. A name made
 * only of ambiguous tokens is skipped rather than guessed at; see
 * \`romanian-names.ts\`.
 *
 * Re-run the generator instead of editing. Read the note at the top of
 * \`scripts/build-given-names.ts\` before trusting a regenerated list.
 */

/** Tokens that behave like given names in the register. */
export const GIVEN_NAMES: ReadonlySet<string> = new Set([
${renderSet(built.given)}
]);

/** Tokens that behave like surnames in the register. */
export const SURNAMES: ReadonlySet<string> = new Set([
${renderSet(built.surnames)}
]);

/** Tokens that are commonly both, and therefore prove nothing on their own. */
export const AMBIGUOUS_NAMES: ReadonlySet<string> = new Set([
${renderSet(built.ambiguous)}
]);
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const names = await readNames();
  if (names.length === 0) {
    console.error("No rows in `people`. Run `npm run import:reps` first.");
    process.exit(1);
  }

  const built = build(names);
  const rendered = render(built);

  console.log(
    `${built.namesRead.toLocaleString("en-US")} names read\n` +
      `  ${built.given.length} given names\n` +
      `  ${built.surnames.length} surnames\n` +
      `  ${built.ambiguous.length} ambiguous\n`,
  );

  /*
   * The sanity check a reader should actually perform. These two lines must
   * look like given names and surnames respectively. If they are swapped, an
   * import changed its name order and this lexicon is inverted — which would
   * be invisible in the diff, since both sets stay the same size.
   */
  console.log(`  given, sample:    ${built.given.slice(0, 12).join(" ")}`);
  console.log(`  surnames, sample: ${built.surnames.slice(0, 12).join(" ")}`);

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
