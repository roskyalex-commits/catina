import { describe, expect, it } from "vitest";
import { SiteFetchError, fingerprintTech, normaliseUrl } from "./fetch-site";

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
