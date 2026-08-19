import { describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  encodeHeaderValue,
  formatAddress,
  sanitiseHeaderValue,
  toGmailRaw,
} from "./mime";

/**
 * Every failure mode here is silent. A mis-encoded header arrives as mojibake,
 * an injected newline adds a Bcc nobody sees, and a missing In-Reply-To starts
 * a new thread that reads as a different person following up.
 */

function decodeBody(mime: string): string {
  const [, body] = mime.split("\r\n\r\n");
  return new TextDecoder().decode(
    Uint8Array.from(atob(body.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)),
  );
}

describe("sanitiseHeaderValue", () => {
  it("strips CR and LF so headers cannot be injected", () => {
    // Without this, a display name can append arbitrary headers.
    expect(sanitiseHeaderValue("Ana\r\nBcc: attacker@evil.com")).toBe(
      "Ana Bcc: attacker@evil.com",
    );
    expect(sanitiseHeaderValue("line\nbreak")).toBe("line break");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitiseHeaderValue("  Ana  ")).toBe("Ana");
  });
});

describe("encodeHeaderValue", () => {
  it("leaves plain ASCII readable", () => {
    // Encoding unconditionally would be valid but makes logs unreadable.
    expect(encodeHeaderValue("Quick question about invoicing")).toBe(
      "Quick question about invoicing",
    );
  });

  it("RFC 2047 encodes non-ASCII", () => {
    // A Romanian name in a subject is illegal raw in a header.
    const encoded = encodeHeaderValue("Întrebare despre facturare");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);

    const base64 = encoded.slice("=?UTF-8?B?".length, -2);
    expect(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))))
      .toBe("Întrebare despre facturare");
  });

  it("encodes Romanian diacritics specifically", () => {
    expect(encodeHeaderValue("Ștefan Țuca")).toMatch(/^=\?UTF-8\?B\?/);
  });

  it("sanitises before encoding", () => {
    expect(encodeHeaderValue("Ana\r\nBcc: x@y.com")).not.toContain("\r");
  });
});

describe("formatAddress", () => {
  it("returns a bare address when there is no display name", () => {
    expect(formatAddress({ email: "ana@firma.ro" })).toBe("ana@firma.ro");
  });

  it("formats a simple name normally", () => {
    expect(formatAddress({ name: "Ana Popescu", email: "ana@firma.ro" })).toBe(
      "Ana Popescu <ana@firma.ro>",
    );
  });

  it("quotes a name containing header specials", () => {
    expect(formatAddress({ name: "Popescu, Ana", email: "ana@firma.ro" })).toBe(
      '"Popescu, Ana" <ana@firma.ro>',
    );
  });

  it("escapes embedded quotes", () => {
    expect(formatAddress({ name: 'Ana "The Closer"', email: "a@x.ro" })).toBe(
      '"Ana \\"The Closer\\"" <a@x.ro>',
    );
  });

  it("uses an encoded-word for a non-ASCII name, unquoted", () => {
    // An encoded-word must not be wrapped in quotes.
    const formatted = formatAddress({ name: "Ștefan Radu", email: "s@x.ro" });
    expect(formatted).toMatch(/^=\?UTF-8\?B\?.+\?= <s@x\.ro>$/);
    expect(formatted).not.toContain('"');
  });

  it("cannot be used to inject a header", () => {
    const formatted = formatAddress({
      name: "Ana\r\nBcc: attacker@evil.com",
      email: "ana@firma.ro",
    });
    expect(formatted).not.toMatch(/[\r\n]/);
  });
});

describe("buildMimeMessage", () => {
  const base = {
    from: { name: "Radu Ionescu", email: "radu@catina.ro" },
    to: { name: "Ana Popescu", email: "ana@firma.ro" },
    subject: "Quick question",
    body: "Hello Ana,\n\nSaw you're hiring a Marketing Director.",
  };

  it("emits the required headers separated by CRLF", () => {
    const mime = buildMimeMessage(base);
    expect(mime).toContain("From: Radu Ionescu <radu@catina.ro>");
    expect(mime).toContain("To: Ana Popescu <ana@firma.ro>");
    expect(mime).toContain("Subject: Quick question");
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime.split("\r\n\r\n")).toHaveLength(2);
  });

  it("round-trips a UTF-8 body", () => {
    const mime = buildMimeMessage({
      ...base,
      body: "Bună ziua, Ștefan!\n\nMulțumesc.",
    });
    expect(decodeBody(mime)).toContain("Bună ziua, Ștefan!");
  });

  it("adds threading headers for a follow-up", () => {
    // Without these the follow-up starts a new thread, which reads as a
    // different person getting in touch.
    const mime = buildMimeMessage({
      ...base,
      inReplyTo: "<msg-1@mail.gmail.com>",
      references: ["<msg-0@mail.gmail.com>", "<msg-1@mail.gmail.com>"],
    });

    expect(mime).toContain("In-Reply-To: <msg-1@mail.gmail.com>");
    expect(mime).toContain(
      "References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>",
    );
  });

  it("adds one-click unsubscribe headers", () => {
    // Gives Gmail a native unsubscribe button — the complaint is what hurts
    // deliverability, so making opting out easy protects the sending domain.
    const mime = buildMimeMessage({
      ...base,
      unsubscribeUrl: "https://catina.ro/u/abc",
    });

    expect(mime).toContain("List-Unsubscribe: <https://catina.ro/u/abc>");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("appends only the disclosures that were required", () => {
    const mime = buildMimeMessage({
      ...base,
      unsubscribeUrl: "https://catina.ro/u/abc",
      required: ["unsubscribe_link", "sender_identity", "data_source_notice"],
      disclosures: {
        senderName: "Radu Ionescu",
        senderCompany: "Cătină SRL",
        postalAddress: "Str. Exemplu 1, Cluj",
        dataSource: "your company is listed in the Romanian trade register",
      },
    });

    const body = decodeBody(mime);
    expect(body).toContain("Radu Ionescu, Cătină SRL");
    expect(body).toContain("Romanian trade register");
    expect(body).toContain("https://catina.ro/u/abc");
    // Postal address wasn't required for this jurisdiction.
    expect(body).not.toContain("Str. Exemplu 1");
  });

  it("omits the footer entirely when nothing is required", () => {
    const body = decodeBody(buildMimeMessage(base));
    expect(body.trim()).toBe(base.body.trim());
  });

  it("wraps base64 output to legal line lengths", () => {
    const mime = buildMimeMessage({ ...base, body: "x".repeat(5000) });
    const [, encoded] = mime.split("\r\n\r\n");
    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it("switches content type for HTML", () => {
    const mime = buildMimeMessage({ ...base, html: true });
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it("encodes a non-ASCII subject", () => {
    const mime = buildMimeMessage({ ...base, subject: "Întrebare rapidă" });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe("toGmailRaw", () => {
  it("produces unpadded base64url", () => {
    const raw = toGmailRaw("From: a@b.ro\r\n\r\nhi");
    expect(raw).not.toMatch(/[+/=]/);
  });

  it("round-trips", () => {
    const mime = "Subject: Bună\r\n\r\ntest";
    const raw = toGmailRaw(mime);
    const restored = new TextDecoder().decode(
      Uint8Array.from(
        atob(raw.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      ),
    );
    expect(restored).toBe(mime);
  });
});
