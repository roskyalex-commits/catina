import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEncryptionKey } from "./crypto";
import { connectMailbox, localDateKey, mailboxFrom, sentToday } from "./mailbox";

/**
 * A row in `email_accounts` is a credential that can send mail as the user, so
 * these tests are about two things: that the token never lands in the database
 * in the clear, and that the daily cap cannot be talked out of counting.
 */

type Row = Record<string, unknown>;

function fakeUpsert() {
  const written: Row[] = [];
  const client = {
    from: vi.fn(() => ({
      upsert: (values: Row) => {
        written.push(values);
        return {
          select: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { ...values, id: "mailbox-1", daily_sent_count: 0 },
                error: null,
              }),
          }),
        };
      },
    })),
  } as unknown as SupabaseClient;
  return { client, written };
}

function fakeCount(result: { count?: number; error?: string }) {
  const client = {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gte: () =>
              Promise.resolve({
                count: result.count ?? null,
                error: result.error ? { message: result.error } : null,
              }),
          }),
        }),
      }),
    })),
  } as unknown as SupabaseClient;
  return client;
}

describe("storing a mailbox", () => {
  it("never writes the refresh token in the clear", async () => {
    const { client, written } = fakeUpsert();
    const key = generateEncryptionKey();

    const result = await connectMailbox(client, {
      orgId: "org-1",
      userId: "user-1",
      address: "Alex@Firma.RO",
      refreshToken: "1//super-secret-refresh-token",
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
      encryptionKey: key,
    });

    expect(result.error).toBeUndefined();
    const stored = String(written[0]?.encrypted_refresh_token ?? "");
    expect(stored).not.toContain("super-secret");
    // `v1.<iv>.<ciphertext>` — the version prefix is what makes rotation
    // possible later without guessing at the format of existing rows.
    expect(stored.startsWith("v1.")).toBe(true);
  });

  it("normalises the address, because the unique index does not", async () => {
    const { client, written } = fakeUpsert();
    await connectMailbox(client, {
      orgId: "org-1",
      userId: "user-1",
      address: "  Alex@Firma.RO ",
      refreshToken: "token",
      scopes: [],
      encryptionKey: generateEncryptionKey(),
    });
    expect(written[0]?.address).toBe("alex@firma.ro");
  });

  it("reactivates a row that was deactivated by a failed refresh", async () => {
    // The commonest reason to reconnect. Leaving `is_active` false would make
    // the reconnection appear to work and then send nothing.
    const { client, written } = fakeUpsert();
    await connectMailbox(client, {
      orgId: "org-1",
      userId: "user-1",
      address: "alex@firma.ro",
      refreshToken: "token",
      scopes: [],
      encryptionKey: generateEncryptionKey(),
    });
    expect(written[0]?.is_active).toBe(true);
  });

  it("refuses rather than storing a mailbox with no address", async () => {
    const { client } = fakeUpsert();
    const result = await connectMailbox(client, {
      orgId: "org-1",
      userId: "user-1",
      address: "   ",
      refreshToken: "token",
      scopes: [],
      encryptionKey: generateEncryptionKey(),
    });
    expect(result.error).toBeTruthy();
    expect(result.mailbox).toBeUndefined();
  });

  it("reports the failure rather than storing a broken ciphertext", async () => {
    const { client, written } = fakeUpsert();
    const result = await connectMailbox(client, {
      orgId: "org-1",
      userId: "user-1",
      address: "alex@firma.ro",
      refreshToken: "token",
      encryptionKey: "not-base64-and-not-32-bytes",
      scopes: [],
    });
    expect(result.error).toMatch(/encrypt/i);
    expect(written).toHaveLength(0);
  });
});

describe("the daily cap counts rows, not a counter", () => {
  it("returns what the messages table says", async () => {
    expect(await sentToday(fakeCount({ count: 7 }), "org-1")).toBe(7);
  });

  it("fails closed when the count cannot be read", async () => {
    /*
     * The direction that matters. Returning 0 on an error would uncap the run,
     * and the daily limit is a deliverability protection rather than a
     * formality — a mailbox that sends 300 cold emails in an afternoon is one
     * Google notices.
     */
    const blocked = await sentToday(fakeCount({ error: "connection reset" }), "org-1");
    expect(blocked).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("mapping a stored row", () => {
  it("defaults a missing is_active to active", () => {
    // Absent and false are different: an older row written before the column
    // existed is a working mailbox, not a disabled one.
    expect(mailboxFrom({ id: "1", org_id: "o", user_id: "u", address: "a@b.ro" }).isActive).toBe(
      true,
    );
    expect(
      mailboxFrom({ id: "1", org_id: "o", user_id: "u", address: "a@b.ro", is_active: false })
        .isActive,
    ).toBe(false);
  });
});

describe("localDateKey", () => {
  it("formats the local day, not the UTC one", () => {
    // 00:30 local on the 2nd is still the 2nd, even where UTC says the 1st.
    const key = localDateKey(new Date(2026, 7, 2, 0, 30));
    expect(key).toBe("2026-08-02");
  });
});
