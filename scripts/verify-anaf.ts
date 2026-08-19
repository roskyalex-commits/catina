/**
 * Verifies the ANAF client against the live API.
 *
 *   npm run verify:anaf
 *
 * Why this exists: the ANAF response shapes in src/lib/sources/anaf/client.ts
 * were written from ANAF's published v9 documentation, not from an observed
 * response, because the environment they were written in had no egress to
 * webservicesp.anaf.ro. This script closes that gap — run it once from a
 * machine with open network access before trusting the registry engine.
 *
 * It checks three things:
 *   1. the envelope parses and the fields we depend on are populated
 *   2. the financial-indicator extraction finds revenue
 *   3. batching and the rate limiter behave against the real endpoint
 *
 * Any FAIL below means the schema needs updating; the raw payload is printed
 * so the correct field names can be read off directly.
 */
import { AnafClient, normaliseCui } from "../src/lib/sources/anaf/client";

/**
 * Well-known, long-established Romanian companies. Picked because they are
 * large, active, and file statements every year — so a null result is a real
 * signal about our code rather than about an obscure company.
 */
const FIXTURES = [
  // Hints corrected against the live API: 14399840 is Dante International
  // (eMAG), not Dedeman, and 14970199 files nothing at all. Getting these
  // wrong made the client look broken when it was reporting the truth.
  { cui: "14399840", hint: "Dante International SA (eMAG)" },
  // Corrected against the live API: 6300978 is not a registered CUI and ANAF
  // 404s on it. Banca Transilvania is 5022670.
  { cui: "5022670", hint: "Banca Transilvania SA" },
  // From our own imported Cluj slice — a small company that files every year,
  // which is the case the product actually depends on.
  { cui: "16238930", hint: "Terabit SA (Cluj)" },
];

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown) {
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`[${mark}] ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) {
      console.log("         ", JSON.stringify(detail, null, 2).slice(0, 900));
    }
  }
}

async function main() {
  console.log("Verifying ANAF client against webservicesp.anaf.ro\n");

  // --- 0. Raw payload, so field names can be corrected by eye ---------------
  console.log("--- raw /PlatitorTvaRest/v9/tva response for one CUI ---");
  try {
    const response = await fetch(
      "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify([
          { cui: Number(FIXTURES[0].cui), data: new Date().toISOString().slice(0, 10) },
        ]),
      },
    );
    const raw = await response.json();
    console.log(JSON.stringify(raw, null, 2).slice(0, 2500));
  } catch (error) {
    console.log("  could not fetch raw payload:", error);
    failures += 1;
  }
  console.log();

  const client = new AnafClient();

  // --- 1. Single lookup -----------------------------------------------------
  console.log("--- lookups ---");
  for (const fixture of FIXTURES) {
    try {
      const company = await client.lookupOne(fixture.cui);
      check(`lookup ${fixture.cui} (${fixture.hint}) returns a company`, !!company);
      if (!company) continue;

      check(`  ${fixture.cui} has a name`, !!company.name, company);
      check(`  ${fixture.cui} has a CAEN code`, !!company.caen, company);
      check(`  ${fixture.cui} has a trade-register number`, !!company.regCom, company);
      check(
        `  ${fixture.cui} has a VAT flag`,
        typeof company.vatRegistered === "boolean",
        company,
      );
      check(`  ${fixture.cui} has a county`, !!company.county, company);
      console.log(
        `         ${company.name} · CAEN ${company.caen} · ${company.county ?? "?"}`,
      );
    } catch (error) {
      check(`lookup ${fixture.cui} (${fixture.hint})`, false, String(error));
    }
  }
  console.log();

  // --- 2. Batching ----------------------------------------------------------
  console.log("--- batching ---");
  try {
    const all = await client.lookupByCui(FIXTURES.map((f) => f.cui));
    check(
      `batch of ${FIXTURES.length} returns ${FIXTURES.length} companies`,
      all.length === FIXTURES.length,
      all.map((c) => c.cui),
    );
  } catch (error) {
    check("batch lookup", false, String(error));
  }
  console.log();

  // --- 3. Financials --------------------------------------------------------
  console.log("--- financial statements ---");
  const year = new Date().getFullYear() - 1;
  for (const fixture of FIXTURES) {
    try {
      // Filings lag, so accept either of the last two years.
      const financials =
        (await client.fetchFinancials(fixture.cui, year)) ??
        (await client.fetchFinancials(fixture.cui, year - 1));

      check(
        `bilant ${fixture.cui} (${fixture.hint}) returns indicators`,
        !!financials && Object.keys(financials.indicators).length > 0,
      );
      if (!financials) continue;

      check(
        `  ${fixture.cui} revenue extracted`,
        typeof financials.revenueRon === "number",
        // Print the labels so the extractor's regexes can be corrected.
        Object.keys(financials.indicators),
      );
      console.log(
        `         ${financials.year}: revenue ${financials.revenueRon ?? "?"} RON, ` +
          `${Object.keys(financials.indicators).length} indicators`,
      );
    } catch (error) {
      check(`bilant ${fixture.cui}`, false, String(error));
    }
  }
  console.log();

  // --- 4. Growth ------------------------------------------------------------
  console.log("--- revenue growth signal ---");
  try {
    const growth = await client.fetchRevenueGrowth(FIXTURES[0].cui, year - 1);
    check("growth computes over two filed years", growth !== null);
    if (growth) {
      console.log(
        `         ${(growth.growthRatio * 100).toFixed(1)}% ` +
          `(${growth.previous.revenueRon} -> ${growth.latest.revenueRon} RON)`,
      );
    }
  } catch (error) {
    check("revenue growth", false, String(error));
  }
  console.log();

  // --- 5. Input handling ----------------------------------------------------
  console.log("--- input handling ---");
  check("RO prefix is stripped", normaliseCui("RO14399840") === "14399840");
  check("trade-register number rejected", normaliseCui("J40/1/2020") === null);
  try {
    const missing = await client.lookupByCui(["99999999"]);
    check("unknown CUI yields no company rather than throwing", missing.length === 0);
  } catch (error) {
    check("unknown CUI handled", false, String(error));
  }

  console.log(
    failures === 0
      ? "\nAll checks passed — the schema matches the live API.\n"
      : `\n${failures} check(s) failed. Update the schema in ` +
          `src/lib/sources/anaf/client.ts using the raw payload above.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("verify-anaf crashed:", error);
  process.exit(1);
});
