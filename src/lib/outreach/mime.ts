import type { RequiredDisclosure } from "./compliance";

/**
 * RFC 5322 message construction for the Gmail API.
 *
 * Gmail takes a base64url-encoded raw message, which means we build the MIME
 * ourselves. Three things bite here and all of them are silent failures:
 *
 *   - Non-ASCII in headers. A Romanian name in a subject line ("Ștefan") is
 *     illegal raw in a header and must be RFC 2047 encoded, or the subject
 *     arrives as mojibake.
 *   - Header injection. A newline in a display name lets an attacker append
 *     arbitrary headers, including Bcc.
 *   - Threading. Replies need In-Reply-To and References or they start a new
 *     thread, which reads as a different person following up.
 */

export type MessageAddress = { name?: string; email: string };

export type BuildMessageInput = {
  from: MessageAddress;
  to: MessageAddress;
  subject: string;
  /** Plain text. HTML is generated from it when `html` is true. */
  body: string;
  /** Threading headers, for follow-ups in a sequence. */
  inReplyTo?: string;
  references?: string[];
  /** Appended below the body, above the signature. */
  unsubscribeUrl?: string;
  disclosures?: DisclosureContent;
  required?: RequiredDisclosure[];
  html?: boolean;
};

export type DisclosureContent = {
  senderName: string;
  senderCompany?: string;
  postalAddress?: string;
  /** Where the recipient's details came from, for GDPR Art. 14. */
  dataSource?: string;
};

/** Strips CR/LF so a value can never inject an extra header. */
export function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** True when any character is outside 7-bit ASCII and so needs encoding. */
export function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 127) return true;
  }
  return false;
}

/**
 * RFC 2047 encoded-word, used only when a header actually needs it.
 *
 * Encoding unconditionally would be valid but makes every subject unreadable
 * in logs and in clients that render the raw header.
 */
export function encodeHeaderValue(value: string): string {
  const clean = sanitiseHeaderValue(value);
  // Non-ASCII needs encoding. A codepoint scan rather than a regex, so the
  // pattern carries no control-character escapes.
  if (!hasNonAscii(clean)) return clean;

  const base64 = bytesToBase64(new TextEncoder().encode(clean));
  return `=?UTF-8?B?${base64}?=`;
}

/**
 * Formats an address, quoting the display name when it contains characters
 * that would otherwise break the header's grammar.
 */
export function formatAddress(address: MessageAddress): string {
  const email = sanitiseHeaderValue(address.email);
  if (!address.name) return email;

  const name = sanitiseHeaderValue(address.name);
  if (!name) return email;

  const encoded = encodeHeaderValue(name);
  // An encoded-word must not be quoted; a plain name with specials must be.
  if (encoded.startsWith("=?")) return `${encoded} <${email}>`;
  if (/[",;:<>@[\]\\.]/.test(name)) {
    return `"${name.replace(/(["\\])/g, "\\$1")}" <${email}>`;
  }
  return `${name} <${email}>`;
}

export function buildMimeMessage(input: BuildMessageInput): string {
  const body = composeBody(input);
  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${formatAddress(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    "MIME-Version: 1.0",
  ];

  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${sanitiseHeaderValue(input.inReplyTo)}`);
  }
  if (input.references?.length) {
    // References is the full chain; In-Reply-To alone is not enough for
    // every client to thread correctly.
    headers.push(
      `References: ${input.references.map(sanitiseHeaderValue).join(" ")}`,
    );
  }

  if (input.unsubscribeUrl) {
    const url = sanitiseHeaderValue(input.unsubscribeUrl);
    // Gives Gmail and Outlook a native unsubscribe button, which reduces
    // spam reports — the complaint being the thing that hurts deliverability.
    headers.push(`List-Unsubscribe: <${url}>`);
    headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }

  headers.push(
    input.html
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
  );
  headers.push("Content-Transfer-Encoding: base64");

  // Body is base64'd rather than sent raw: it sidesteps the 998-octet line
  // limit and any accidental bare "." or "From " at line start.
  const encodedBody = wrap76(bytesToBase64(new TextEncoder().encode(body)));

  return `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
}

/** Gmail's `raw` field is base64url with padding stripped. */
export function toGmailRaw(mime: string): string {
  return bytesToBase64(new TextEncoder().encode(mime))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function composeBody(input: BuildMessageInput): string {
  const parts = [input.body.trim()];
  const required = new Set(input.required ?? []);
  const disclosures = input.disclosures;
  const footer: string[] = [];

  if (disclosures) {
    if (required.has("sender_identity")) {
      footer.push(
        disclosures.senderCompany
          ? `${disclosures.senderName}, ${disclosures.senderCompany}`
          : disclosures.senderName,
      );
    }
    if (required.has("postal_address") && disclosures.postalAddress) {
      footer.push(disclosures.postalAddress);
    }
    if (required.has("data_source_notice") && disclosures.dataSource) {
      // GDPR Art. 14 — the recipient must be told where their details came
      // from, because they did not provide them.
      footer.push(`You're receiving this because ${disclosures.dataSource}.`);
    }
  }

  if (input.unsubscribeUrl && required.has("unsubscribe_link")) {
    footer.push(`To stop receiving these, reply STOP or use ${input.unsubscribeUrl}`);
  }

  if (footer.length > 0) {
    parts.push("--", footer.join("\n"));
  }
  return parts.join("\n\n");
}

/** Base64 without node:Buffer, which does not exist in Workers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked to avoid blowing the argument limit on a large body.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function wrap76(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join("\r\n");
}
