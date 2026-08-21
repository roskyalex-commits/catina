import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchContactAddresses } from "./fetch-site";

/**
 * The distinction this file exists to protect: "we read the site and it
 * publishes no address" versus "we could not read the site".
 *
 * Both used to return an empty array, so the harvester recorded them
 * identically — and marked the second as a settled answer. A degraded run then
 * buried 3,333 domains that way, reporting 0.2% readable where a fresh sample
 * of the same domains gave 15%.
 */

type Page = { status?: number; body?: string; contentType?: string };

/** Serve a fixed set of paths; anything else 404s, like a well-behaved site. */
function serve(pages: Record<string, Page>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const page = pages[path];
    if (!page) return new Response("nope", { status: 404 });
    return new Response(page.body ?? "<html><body>hi</body></html>", {
      status: page.status ?? 200,
      headers: { "content-type": page.contentType ?? "text/html" },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("unreadable is not the same as empty", () => {
  it("reports zero pages when nothing could be fetched", async () => {
    serve({});
    const result = await fetchContactAddresses("firma.ro");

    expect(result.addresses).toEqual([]);
    // The bit that matters: the caller must be able to see this is a retry,
    // not a result.
    expect(result.pagesRead).toBe(0);
  });

  it("reports pages read when the site answered but published nothing", async () => {
    serve({ "/contact": { body: "<html><body>Call us on 0740 123 456</body></html>" } });
    const result = await fetchContactAddresses("firma.ro");

    expect(result.addresses).toEqual([]);
    expect(result.pagesRead).toBeGreaterThan(0);
  });

  it("reports zero pages for a domain it cannot even parse", async () => {
    serve({});
    expect((await fetchContactAddresses("not a domain")).pagesRead).toBe(0);
  });
});

describe("a soft-404 site does not burn the page budget", () => {
  it("counts five identical bodies as one page", async () => {
    /*
     * Real behaviour, found on estival.ro: every path returns 200 with the
     * same homepage. Before the body check, `/contact`, `/contacte`, `/echipa`,
     * `/team` and `/despre-noi` each counted, spending the whole five-page
     * budget on five copies of one page and never reaching `/`.
     */
    const homepage = `<html><body>${"x".repeat(600)}</body></html>`;
    serve({
      "/contact": { body: homepage },
      "/contacte": { body: homepage },
      "/echipa": { body: homepage },
      "/team": { body: homepage },
      "/despre-noi": { body: homepage },
      "/about": { body: homepage },
      "/management": { body: homepage },
      "/conducere": { body: homepage },
      "/": { body: homepage },
    });

    const result = await fetchContactAddresses("firma.ro");
    expect(result.pagesRead).toBe(1);
  });

  it("still reaches a later path when the earlier ones are duplicates", async () => {
    const homepage = `<html><body>${"x".repeat(600)}</body></html>`;
    serve({
      "/contact": { body: homepage },
      "/contacte": { body: homepage },
      "/echipa": { body: homepage },
      "/team": { body: homepage },
      "/despre-noi": { body: homepage },
      // Ninth in the list — unreachable before the duplicate check existed.
      "/": { body: "<html><body>scrie la ion.popescu@firma.ro</body></html>" },
    });

    const result = await fetchContactAddresses("firma.ro");
    expect(result.addresses.map((a) => a.address)).toContain("ion.popescu@firma.ro");
  });
});

describe("what it collects", () => {
  it("keeps personal and role addresses apart, with provenance on each", async () => {
    serve({
      "/contact": {
        body:
          "<html><body>office@firma.ro and ion.popescu@firma.ro</body></html>",
      },
    });

    const { addresses } = await fetchContactAddresses("firma.ro");
    const byAddress = Object.fromEntries(addresses.map((a) => [a.address, a]));

    expect(byAddress["office@firma.ro"].isRole).toBe(true);
    expect(byAddress["ion.popescu@firma.ro"].isRole).toBe(false);
    // Provenance is not optional for a harvested address — it is what answers
    // "where did you get this".
    expect(byAddress["ion.popescu@firma.ro"].sourceUrl).toContain("/contact");
  });

  it("treats a qualified role mailbox as a role address", async () => {
    /*
     * `office-vw@` on a dealership, `vanzari.bucuresti@` on a branch. Real
     * addresses from the harvest, all filed as personal because the local part
     * is not exactly `office`. The error runs the wrong way for the consent
     * posture: it overstates what we hold about an individual.
     */
    serve({
      "/contact": {
        body:
          "<html><body>office-vw@firma.ro vanzari.bucuresti@firma.ro " +
          "ion.popescu@firma.ro</body></html>",
      },
    });

    const { addresses } = await fetchContactAddresses("firma.ro");
    const byAddress = Object.fromEntries(addresses.map((a) => [a.address, a]));

    expect(byAddress["office-vw@firma.ro"].isRole).toBe(true);
    expect(byAddress["vanzari.bucuresti@firma.ro"].isRole).toBe(true);
    // And a real person is still a real person.
    expect(byAddress["ion.popescu@firma.ro"].isRole).toBe(false);
  });

  it("treats the Romanian departmental names as role addresses", async () => {
    // These were classified as personal until the prefix list was widened, and
    // the role/personal line is what the consent posture rests on.
    serve({
      "/contact": {
        body: "<html><body>administratie@firma.ro comercial@firma.ro</body></html>",
      },
    });

    const { addresses } = await fetchContactAddresses("firma.ro");
    expect(addresses.every((a) => a.isRole)).toBe(true);
  });
});
