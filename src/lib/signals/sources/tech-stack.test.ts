import { describe, expect, it } from "vitest";
import type { SiteSnapshot } from "@/lib/crawl/fetch-site";
import type { SignalScanContext } from "../types";
import { TechStackSignalSource } from "./website";

/**
 * A tech-stack signal becomes the opening line of a cold email, verbatim. That
 * is the standard these tests hold it to — not "did it emit something", but
 * "would a stranger reading this believe a person looked at their company".
 *
 * Both failures below were found on real leads, after the messages had been
 * drafted: **72 of 101 mid-market messages would have opened with "I saw you
 * started using Apache"**. Nothing errored. Every layer did what it was told.
 */

function snapshot(techStack: string[]): SiteSnapshot {
  return {
    domain: "exemplu.ro",
    origin: "https://exemplu.ro",
    pages: [{ url: "https://exemplu.ro/", title: "t", text: "Bine ați venit." }],
    techStack,
    roleEmails: [],
    socialLinks: {},
  };
}

function context(
  previous: string[] | undefined,
  current: string[],
): SignalScanContext {
  return {
    company: { dedupeKey: "cui:1", name: "EXEMPLU SRL", domain: "exemplu.ro", source: "onrc" },
    previous: previous === undefined ? undefined : { techStack: previous },
    site: async () => snapshot(current),
  };
}

const source = new TechStackSignalSource();

describe("what counts as having something to diff against", () => {
  it("does not apply before any scan", () => {
    expect(source.isApplicable(context(undefined, []))).toBe(false);
  });

  it("does not apply when the previous scan found no technology at all", async () => {
    /*
     * The bug, in one line: `Boolean([])` is true. A first scan that detected
     * nothing passed the gate, and then the site's entire stack read as newly
     * added — which is how 241 companies acquired a signal saying "Started
     * using WordPress". A first observation is not a change.
     */
    expect(source.isApplicable(context([], ["WordPress", "WooCommerce"]))).toBe(false);
    expect(await source.scan(context([], ["WordPress", "WooCommerce"]))).toEqual([]);
  });

  it("applies once a previous scan recorded something", () => {
    expect(source.isApplicable(context(["WordPress"], ["WordPress"]))).toBe(true);
  });
});

describe("commodity infrastructure is not a buying signal", () => {
  it("emits nothing when only commodity technology appeared", async () => {
    // Apache, PHP, nginx, Cloudflare, WordPress and Google Analytics are on
    // half the web. Their appearance says nothing about a budget.
    const signals = await source.scan(
      context(["WordPress"], ["WordPress", "Apache", "PHP", "Google Analytics", "Cloudflare"]),
    );
    expect(signals).toEqual([]);
  });

  it("emits when a platform that costs money appeared", async () => {
    const signals = await source.scan(context(["WordPress"], ["WordPress", "WooCommerce"]));
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("tech_stack_added");
    expect(signals[0].strength).toBe(0.8);
  });

  it("names only the technology that mattered", async () => {
    /*
     * The title is read verbatim by the SIGNAL column and by the drafter, so
     * burying "WooCommerce" among four commodity entries is not a cosmetic
     * problem — it is the opening line of the email.
     */
    const signals = await source.scan(
      context(["WordPress"], ["WordPress", "Apache", "Google Analytics", "WooCommerce", "PHP"]),
    );
    expect(signals[0].title).toBe("Started using WooCommerce");
    expect(signals[0].title).not.toContain("Apache");
  });

  it("keeps the full diff as evidence even though it does not headline it", async () => {
    const signals = await source.scan(
      context(["WordPress"], ["WordPress", "Apache", "WooCommerce"]),
    );
    expect(signals[0].payload?.added).toEqual(["Apache", "WooCommerce"]);
    expect(signals[0].payload?.notable).toEqual(["WooCommerce"]);
  });
});

describe("dropping a platform", () => {
  it("fires when a paid platform disappeared — they are switching to something", async () => {
    const signals = await source.scan(context(["WordPress", "Magento"], ["WordPress"]));
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("tech_stack_removed");
    expect(signals[0].title).toBe("Stopped using Magento");
  });

  it("says nothing when a company merely stopped serving a header", async () => {
    // "I noticed you stopped using nginx" is not a sentence to send anyone.
    const signals = await source.scan(
      context(["WordPress", "nginx", "Apache"], ["WordPress"]),
    );
    expect(signals).toEqual([]);
  });
});

describe("dedupe key", () => {
  it("is stable when an analytics tag arrives alongside the platform", async () => {
    // Same adoption, seen twice, with noise attached the second time. Keying on
    // the full diff would write a second row for the same event.
    const first = await source.scan(context(["WordPress"], ["WordPress", "WooCommerce"]));
    const second = await source.scan(
      context(["WordPress"], ["WordPress", "WooCommerce", "Hotjar", "Apache"]),
    );
    expect(second[0].dedupeKey).toBe(first[0].dedupeKey);
  });

  it("orders the notable set so scan order cannot change the key", async () => {
    const a = await source.scan(context(["WordPress"], ["WordPress", "Stripe", "WooCommerce"]));
    const b = await source.scan(context(["WordPress"], ["WordPress", "WooCommerce", "Stripe"]));
    expect(a[0].dedupeKey).toBe(b[0].dedupeKey);
  });
});
