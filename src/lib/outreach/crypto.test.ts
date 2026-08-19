import { describe, expect, it } from "vitest";
import {
  EncryptionError,
  decryptToken,
  encryptToken,
  generateEncryptionKey,
} from "./crypto";

/**
 * A Gmail refresh token can send mail as the user indefinitely. These tests
 * pin the properties that make a stolen database dump insufficient on its own:
 * the key stays out of the data, tampering fails loudly, and the same
 * plaintext never encrypts to the same ciphertext twice.
 */

const key = generateEncryptionKey();

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", async () => {
    const token = "1//0gFakeRefreshToken_abc-123";
    expect(await decryptToken(await encryptToken(token, key), key)).toBe(token);
  });

  it("round-trips UTF-8", async () => {
    const value = "tokén-cu-diacritice-Ștefan";
    expect(await decryptToken(await encryptToken(value, key), key)).toBe(value);
  });

  it("produces different ciphertext each time", async () => {
    // A fresh IV per encryption is mandatory for GCM — reusing one with the
    // same key breaks the cipher outright, not just weakens it.
    const a = await encryptToken("same-token", key);
    const b = await encryptToken("same-token", key);
    expect(a).not.toBe(b);
    expect(await decryptToken(a, key)).toBe(await decryptToken(b, key));
  });

  it("carries a version prefix so keys can be rotated later", async () => {
    const encrypted = await encryptToken("t", key);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(encrypted.split(".")).toHaveLength(3);
  });

  it("never contains the plaintext", async () => {
    const encrypted = await encryptToken("SUPER_SECRET_TOKEN", key);
    expect(encrypted).not.toContain("SUPER_SECRET_TOKEN");
  });
});

describe("decryptToken — failure modes", () => {
  it("fails with the wrong key rather than returning garbage", async () => {
    const encrypted = await encryptToken("token", key);
    await expect(decryptToken(encrypted, generateEncryptionKey())).rejects.toThrow(
      EncryptionError,
    );
  });

  it("fails when the ciphertext was tampered with", async () => {
    // GCM is authenticated: this is the property that makes tampering loud.
    const encrypted = await encryptToken("token", key);
    const [version, iv, ciphertext] = encrypted.split(".");
    const flipped = ciphertext.slice(0, -4) + (ciphertext.endsWith("A") ? "B" : "A") + ciphertext.slice(-3);

    await expect(
      decryptToken(`${version}.${iv}.${flipped}`, key),
    ).rejects.toThrow(/tampered|decrypt/i);
  });

  it("rejects an unrecognised format", async () => {
    await expect(decryptToken("not-encrypted", key)).rejects.toThrow(
      /unrecognised ciphertext/,
    );
    await expect(decryptToken("v2.a.b", key)).rejects.toThrow(
      /unrecognised ciphertext/,
    );
  });
});

describe("key validation", () => {
  it("rejects a key of the wrong length with actionable advice", async () => {
    // The likeliest setup mistake, so the error names the fix.
    await expect(encryptToken("t", btoa("too-short"))).rejects.toThrow(
      /must decode to 32 bytes/,
    );
    await expect(encryptToken("t", btoa("too-short"))).rejects.toThrow(
      /openssl rand -base64 32/,
    );
  });

  it("rejects a key that is not base64", async () => {
    await expect(encryptToken("t", "!!!not base64!!!")).rejects.toThrow(
      /not valid base64/,
    );
  });

  it("refuses to encrypt an empty value", async () => {
    // Silently storing an empty token would surface much later as a confusing
    // auth failure.
    await expect(encryptToken("", key)).rejects.toThrow(/empty value/);
  });
});

describe("generateEncryptionKey", () => {
  it("produces a distinct 32-byte base64 key each call", () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(32);
  });
});
