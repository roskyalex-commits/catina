import { describe, expect, it } from "vitest";
import {
  SiteFetchError,
  extractEmails,
  fingerprintTech,
  normaliseUrl,
} from "./fetch-site";

describe("normaliseUrl", () => {
  it("adds a scheme when the user pastes a bare domain", () => {
    // This is the common case: onboarding asks for "your website".
    expect(normaliseUrl("catina.ro").toString()).toBe("https://catina.ro/");
    expect(normaliseUrl("  www.emag.ro  ").hostname).toBe("www.emag.ro");
  });

  it("keeps an explicit scheme and path", () => {
    const url = normaliseUrl("http://example.com/about");
    expect(url.protocol).toBe("http:");
    expect(url.pathname).toBe("/about");
  });

  it("rejects input with no dot in the hostname", () => {
    // Guards against the user typing a company name instead of a domain.
    expect(() => normaliseUrl("localhost")).toThrow(SiteFetchError);
    expect(() => normaliseUrl("my company")).toThrow(SiteFetchError);
  });
});

describe("fingerprintTech", () => {
  const noHeaders = new Headers();

  it("detects mainstream stacks from markup", () => {
    const html = `<script src="https://cdn.shopify.com/s/x.js"></script>
      <script src="https://js.stripe.com/v3"></script>`;
    expect(fingerprintTech(html, noHeaders)).toEqual(["Shopify", "Stripe"]);
  });

  it("detects Romanian-market platforms international tools miss", () => {
    // This is the point of rolling our own instead of paying for BuiltWith.
    const html = `<a href="https://www.gomag.ro">Powered by Gomag</a>
      <form action="https://secure.euplatesc.ro/pay"></form>`;
    expect(fingerprintTech(html, noHeaders)).toEqual(["EuPlatesc", "Gomag"]);
  });

  it("reads server and x-powered-by headers", () => {
    const headers = new Headers({
      server: "nginx/1.24.0",
      "x-powered-by": "PHP/8.2.1",
    });
    expect(fingerprintTech("<html></html>", headers)).toEqual(["PHP", "nginx"]);
  });

  it("is case-insensitive over markup", () => {
    expect(fingerprintTech('<DIV CLASS="WP-CONTENT">', noHeaders)).toContain(
      "WordPress",
    );
  });

  it("returns an empty list for a plain page rather than guessing", () => {
    expect(fingerprintTech("<html><body>hi</body></html>", noHeaders)).toEqual(
      [],
    );
  });
});

/**
 * The role-only mode is a legal boundary, not a tuning knob. Onboarding
 * analyses the user's own site and may take what it finds; prospect crawling
 * runs over thousands of companies who have not asked us for anything, and
 * Law 506/2004 has no B2B exemption.
 */
describe("extractEmails", () => {
  const page = `
    <footer>
      <a href="mailto:office@firma.ro">office@firma.ro</a>
      <a href="mailto:ion.popescu@firma.ro">ion.popescu@firma.ro</a>
      <a href="mailto:hello@agentia-web.ro">hello@agentia-web.ro</a>
    </footer>`;

  it("keeps role addresses at this domain and drops other people's", () => {
    // The agency that built the site is not the prospect.
    expect(extractEmails(page, "firma.ro")).toEqual(["office@firma.ro"]);
  });

  it("falls back to every same-domain address when no role one exists", () => {
    const personalOnly = `<a href="mailto:ion.popescu@firma.ro">Ion</a>`;
    expect(extractEmails(personalOnly, "firma.ro")).toEqual(["ion.popescu@firma.ro"]);
  });

  it("returns nothing rather than a personal address in role-only mode", () => {
    const personalOnly = `<a href="mailto:ion.popescu@firma.ro">Ion</a>`;
    expect(extractEmails(personalOnly, "firma.ro", { roleOnly: true })).toEqual([]);
  });

  it("recognises the Romanian role prefixes, not only the English ones", () => {
    const romanian = `<p>vanzari@firma.ro secretariat@firma.ro comenzi@firma.ro</p>`;
    expect(extractEmails(romanian, "firma.ro", { roleOnly: true })).toHaveLength(3);
  });

  it("ignores asset filenames that look like addresses", () => {
    const asset = `<img src="sprite@2x.png"><a href="mailto:office@firma.ro">x</a>`;
    expect(extractEmails(asset, "firma.ro", { roleOnly: true })).toEqual([
      "office@firma.ro",
    ]);
  });

  it("matches a subdomain of the company, not a lookalike domain", () => {
    const mixed = `office@mail.firma.ro office@firma.ro.evil.com`;
    expect(extractEmails(mixed, "firma.ro", { roleOnly: true })).toEqual([
      "office@mail.firma.ro",
    ]);
  });
});
