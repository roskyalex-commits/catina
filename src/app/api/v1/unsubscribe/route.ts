import { NextResponse } from "next/server";
import { isDatabaseConfigured } from "@/lib/env";
import { domainOf, suppress } from "@/lib/outreach/suppressions";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { optionalString } from "@/lib/supabase/row";

export const dynamic = "force-dynamic";

/**
 * Unsubscribe. Public, unauthenticated, and the only endpoint here that must
 * work for someone who has never heard of this product.
 *
 * The body of every message we send carries this link and the headers carry it
 * twice more (`List-Unsubscribe` and `List-Unsubscribe-Post`), which is what
 * gives Gmail and Outlook their native unsubscribe button. That button issues a
 * **POST with no confirmation step** (RFC 8058), so POST here must complete the
 * opt-out immediately — a POST that renders a "are you sure?" page silently
 * fails to unsubscribe anyone who used the button, which is most people.
 *
 * ## Why the message id is the whole credential
 *
 * `?m=<uuid>` and nothing else. A v4 UUID is 122 bits of randomness, so it is
 * not enumerable, and it identifies the recipient without putting their email
 * address into a URL that ends up in proxy logs, browser history and referrer
 * headers. The trade is that anyone holding the link can unsubscribe that
 * recipient — which is a feature. Forwarding the mail to a colleague and having
 * them opt the company out is a legitimate thing to want.
 *
 * ## What it suppresses
 *
 * The address, and — when the recipient asks for it — the domain. `?scope=domain`
 * comes from the confirmation page, because "take our whole company off your
 * list" is the way an opt-out usually arrives in B2B and honouring it for one
 * person is how the second complaint happens.
 *
 * Never reveals whether the id was real. A 404 that distinguishes valid from
 * invalid ids turns this into an oracle for testing guesses.
 */

const PAGE_STYLE =
  "font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a";

export async function POST(request: Request) {
  const result = await unsubscribeFrom(request);
  // The mail client wants a 200 and does not render the body.
  return NextResponse.json({ ok: result.ok });
}

export async function GET(request: Request) {
  const result = await unsubscribeFrom(request);
  const title = "You've been unsubscribed";

  // The same title either way. A page that says "no such subscription" would
  // confirm which ids are real — see the note above.
  if (!result.ok || !result.value) {
    return html(page(title, "<p>If you were on our list, you are not any more.</p>"));
  }

  const parts = [
    `<p>We won't contact <strong>${escapeHtml(result.value)}</strong> again.</p>`,
  ];

  if (result.domain) {
    const action = `${escapeHtml(result.selfUrl)}&amp;scope=domain`;
    parts.push(
      `<form method="post" action="${action}">`,
      `<p>Want us to stop contacting anyone at <strong>${escapeHtml(result.domain)}</strong>?</p>`,
      `<button type="submit" style="font:inherit;padding:.6rem 1rem;border:1px solid #1a1a1a;background:#fff;border-radius:.4rem;cursor:pointer">Unsubscribe the whole company</button>`,
      `</form>`,
    );
  }

  return html(page(title, parts.join("")));
}

type Outcome = {
  ok: boolean;
  value?: string;
  domain?: string | null;
  selfUrl: string;
};

async function unsubscribeFrom(request: Request): Promise<Outcome> {
  const url = new URL(request.url);
  const messageId = url.searchParams.get("m")?.trim() ?? "";
  const wholeDomain = url.searchParams.get("scope") === "domain";
  const selfUrl = `${url.origin}${url.pathname}?m=${encodeURIComponent(messageId)}`;

  // Deliberately indistinguishable from "no such message" below.
  if (!messageId || !isDatabaseConfigured()) return { ok: false, selfUrl };

  try {
    const admin = createSupabaseAdminClient();

    const { data, error } = await admin
      .from("messages")
      .select("id, org_id, lead_id, leads(emails(address))")
      .eq("id", messageId)
      .maybeSingle();

    if (error || !data) return { ok: false, selfUrl };

    const row = data as Record<string, unknown>;
    const address = addressOf(row);
    const orgId = optionalString(row.org_id);
    if (!address || !orgId) return { ok: false, selfUrl };

    const domain = domainOf(address);
    const written = await suppress(admin, orgId, [
      { value: address, kind: "address", reason: "unsubscribed" },
      ...(wholeDomain && domain
        ? ([{ value: domain, kind: "domain", reason: "unsubscribed" }] as const)
        : []),
    ]);

    if (written.error) {
      // Loud in the log, quiet to the recipient: they cannot act on it and
      // telling them the request half-worked is worse than telling them it
      // worked while we fix it.
      console.error("Recording an unsubscribe failed:", written.error);
      return { ok: false, selfUrl };
    }

    /*
     * Stop the rest of the sequence too. Suppression already blocks the send,
     * but leaving the lead `queued` means the queue screen keeps showing a
     * message that will never go out, and the user has no idea why.
     */
    const leadId = optionalString(row.lead_id);
    if (leadId) {
      await admin
        .from("leads")
        .update({
          status: "rejected",
          rejected_reason: "Unsubscribed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", leadId);
    }

    return { ok: true, value: address, domain, selfUrl };
  } catch (error) {
    console.error(
      "Unsubscribe failed:",
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, selfUrl };
  }
}

function addressOf(row: Record<string, unknown>): string | null {
  const lead = embedded(row.leads);
  const email = embedded(lead?.emails);
  return optionalString(email?.address);
}

function embedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="${PAGE_STYLE}"><h1 style="font-size:1.4rem">${escapeHtml(title)}</h1>${body}</body></html>`
  );
}

function html(markup: string): Response {
  return new Response(markup, {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
