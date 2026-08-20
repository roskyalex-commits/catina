/**
 * Does the model key actually work?
 *
 *   npm run verify:llm
 *
 * Run this the moment a key is pasted into `.env.local`. It needs no database,
 * no dev server and no network beyond the model provider, and it answers the
 * three questions that matter in order: is a key present, does the provider
 * accept it, and can it fill the real ICP schema rather than a toy one.
 *
 * The last one is the point. A key that authenticates but produces a schema
 * violation is worse than no key, because the failure surfaces as "could not
 * build an ICP from this site" and sends the reader off to blame the crawler.
 */
import { z } from "zod";
import { INDUSTRY_KEYS } from "../src/lib/icp/industries";
import { COMPANY_TYPES, SENIORITIES } from "../src/lib/icp/schema";
import { allExtractors, configuredExtractors } from "../src/lib/llm/registry";
import { LlmError } from "../src/lib/llm/types";
import "./load-env";

/**
 * The shipped extraction schema, restated.
 *
 * Imported would be better, but `analyze.ts` keeps it private on purpose — it
 * is an implementation detail of one function. Restating the *shape* here is
 * the trade: this checks that a provider can handle fifteen fields, arrays of
 * 37-value enums and long descriptions, which is what actually breaks.
 */
const extractionSchema = z.object({
  valueProp: z.string().describe("One sentence on what they sell and to whom."),
  productName: z.string().describe("Short name of the offering. '' if unclear."),
  targetTitles: z.array(z.string()).describe("3-10 job titles of the buyers."),
  targetSeniorities: z.array(z.enum(SENIORITIES)).describe("Seniority buckets."),
  industries: z.array(z.string()).describe("3-8 industries, in English."),
  industryKeys: z.array(z.enum(INDUSTRY_KEYS)).describe("2-5 from the list."),
  companyTypes: z.array(z.enum(COMPANY_TYPES)).describe("Company archetypes."),
  countries: z.array(z.string()).describe("ISO 3166-1 alpha-2 codes."),
  keywords: z.array(z.string()).describe("5-12 keywords."),
  competitors: z.array(z.string()).describe("0-10 competing products."),
  exclusions: z.array(z.string()).describe("Segments to keep out."),
  employeeMin: z.number().int().describe("Smallest headcount. 0 if unknown."),
  employeeMax: z.number().int().describe("Largest headcount. 0 if unknown."),
  confidence: z.number().describe("0-1."),
  assumptions: z.array(z.string()).describe("Anything guessed, not read."),
});

/** A tiny fake site. Real enough to infer from, short enough to cost nothing. */
const SAMPLE = `Company domain: exemplu.ro

<website_content>
<page url="https://exemplu.ro/" title="Exemplu — facturare online">
Exemplu este o platformă de facturare și e-Factura pentru firme mici din
România. Ne folosesc magazine online, firme de distribuție și cabinete de
contabilitate. Integrare directă cu ANAF. Preturi de la 49 RON/luna.
</page>
</website_content>

Build the ICP for this company.`;

const SYSTEM =
  "You build B2B ideal-customer profiles. Infer who the company sells to, " +
  "not what it is. Pick industryKeys for the BUYERS. Ground every field in " +
  "the page; record guesses in assumptions.";

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`[${ok ? "  ok  " : " FAIL "}] ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log("          ", String(detail).slice(0, 400));
  }
}

async function main() {
  const env = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
  };

  console.log("providers:");
  for (const extractor of allExtractors(env)) {
    console.log(
      `  ${extractor.isConfigured() ? "configured  " : "no key      "} ${extractor.label}`,
    );
  }
  console.log("");

  const configured = configuredExtractors(env);
  if (configured.length === 0) {
    console.log(
      "Neither key is set, so nothing was called.\n\n" +
        "  ANTHROPIC_API_KEY  https://console.anthropic.com/settings/keys\n" +
        "  GEMINI_API_KEY     https://aistudio.google.com/apikey  (free tier)\n\n" +
        "Put one in .env.local and run this again.",
    );
    return;
  }

  for (const extractor of configured) {
    console.log(`--- ${extractor.label}`);
    const started = Date.now();

    try {
      const result = await extractor.extract({
        system: SYSTEM,
        user: SAMPLE,
        schema: extractionSchema,
        schemaName: "icp",
      });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      check(`${extractor.key}: filled the schema (${elapsed}s)`, true);
      check(
        `${extractor.key}: picked industry keys from the catalogue`,
        result.industryKeys.length > 0,
        result.industryKeys,
      );
      check(
        `${extractor.key}: inferred a Romanian market`,
        result.countries.includes("RO"),
        result.countries,
      );
      check(
        `${extractor.key}: produced usable keywords`,
        result.keywords.length >= 3,
        result.keywords,
      );

      console.log(`\n  value prop : ${result.valueProp}`);
      console.log(`  industries : ${result.industryKeys.join(", ")}`);
      console.log(`  titles     : ${result.targetTitles.slice(0, 4).join(", ")}`);
      console.log(`  keywords   : ${result.keywords.slice(0, 8).join(", ")}`);
      console.log(`  competitors: ${result.competitors.join(", ") || "none named"}`);
      console.log(`  confidence : ${result.confidence}\n`);
    } catch (error) {
      const reason = error instanceof LlmError ? error.reason : "threw";
      check(
        `${extractor.key}: ${reason}`,
        false,
        error instanceof Error ? error.message : error,
      );
      console.log("");
    }
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error("The run threw:", error instanceof Error ? error.message : error);
  })
  .finally(() => {
    console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
