/**
 * Encryption for OAuth refresh tokens at rest.
 *
 * A Gmail refresh token is a long-lived credential that can send mail as the
 * user. A database leak that exposes them is materially worse than one that
 * exposes lead data, so they are encrypted with a key that lives only in the
 * environment — a stolen database dump alone is not enough to use them.
 *
 * AES-GCM via WebCrypto, because Workers has no node:crypto. GCM is
 * authenticated, so tampering fails loudly rather than decrypting to garbage.
 */

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(base64Key.trim());
  } catch {
    throw new EncryptionError(
      "ENCRYPTION_KEY is not valid base64. Generate one with: openssl rand -base64 32",
    );
  }

  if (raw.length !== KEY_BYTES) {
    throw new EncryptionError(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  return crypto.subtle.importKey("raw", raw as BufferSource, ALGORITHM, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Returns `v1.<iv>.<ciphertext>`, both base64.
 *
 * The version prefix is what makes key rotation possible later without
 * guessing at the format of existing rows.
 */
export async function encryptToken(
  plaintext: string,
  base64Key: string,
): Promise<string> {
  if (!plaintext) throw new EncryptionError("refusing to encrypt an empty value");

  const key = await importKey(base64Key);
  // A fresh IV per encryption is mandatory for GCM: reusing one with the same
  // key breaks the cipher outright, not just weakens it.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(
  encoded: string,
  base64Key: string,
): Promise<string> {
  const parts = encoded.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new EncryptionError("unrecognised ciphertext format");
  }

  const key = await importKey(base64Key);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: base64ToBytes(parts[1]) as BufferSource },
      key,
      base64ToBytes(parts[2]) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // GCM authentication failed: wrong key, or the ciphertext was altered.
    // Both are indistinguishable by design and both must fail closed.
    throw new EncryptionError(
      "could not decrypt — wrong ENCRYPTION_KEY, or the stored value was tampered with",
    );
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Convenience for the setup docs and the settings page. */
export function generateEncryptionKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
