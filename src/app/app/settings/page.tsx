import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Mail,
  Settings as SettingsIcon,
  XCircle,
} from "lucide-react";
import { Card, PageHeader, Pill, buttonClass } from "@/components/ui/primitives";
import { describeEnv } from "@/lib/env";
import { listConnectedMailboxes } from "@/lib/data/mailboxes";

export const dynamic = "force-dynamic";

/**
 * Configuration status.
 *
 * Reads the live environment rather than a stored setting, because the failure
 * this screen exists to prevent — an agent silently finding nothing because a
 * key was never set — is invisible everywhere else in the product.
 */

type Row = {
  label: string;
  configured: boolean;
  required: boolean;
  note: string;
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const env = describeEnv();
  const params = await searchParams;
  const mailboxes = await listConnectedMailboxes();
  const has = (key: string) => env.configuredProviders.includes(key as never);
  const missing = (key: string) => env.missingRequired.includes(key);

  const core: Row[] = [
    {
      label: "Supabase (EU / Frankfurt)",
      configured: !missing("NEXT_PUBLIC_SUPABASE_URL") && !missing("SUPABASE_SERVICE_ROLE_KEY"),
      required: true,
      note: "Postgres, auth and row-level security. Must be an EU region for GDPR residency.",
    },
    {
      label: "Anthropic API",
      configured: !missing("ANTHROPIC_API_KEY"),
      required: true,
      note: "ICP inference and message drafting. The only line item with a real cost.",
    },
    {
      label: "Token encryption key",
      configured: !missing("ENCRYPTION_KEY"),
      required: true,
      note: "Encrypts Gmail refresh tokens at rest. openssl rand -base64 32",
    },
    {
      label: "Gmail OAuth",
      configured: has("GOOGLE_CLIENT_ID"),
      required: false,
      note: "gmail.send + gmail.compose. Both sensitive scopes — no CASA audit needed.",
    },
  ];

  const sources: Row[] = [
    {
      label: "Romanian registry (ANAF / ONRC)",
      configured: true,
      required: false,
      note: "Free, no API key, no account. Always available — the reason RO sourcing costs nothing.",
    },
    {
      label: "Hunter.io",
      configured: has("HUNTER_API_KEY"),
      required: false,
      note: "Domain search. Free plan documented to include API access.",
    },
    {
      label: "Prospeo",
      configured: has("PROSPEO_API_KEY"),
      required: false,
      note: "Domain search, strong on European lists.",
    },
    {
      label: "People Data Labs",
      configured: has("PDL_API_KEY"),
      required: false,
      note: "Person search. No verified emails — still needs the waterfall on top.",
    },
    {
      label: "Apify",
      configured: has("APIFY_TOKEN"),
      required: false,
      note: "Marketplace actors. Also needs APIFY_PEOPLE_ACTOR to be useful.",
    },
  ];

  return (
    <>
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        description="What's wired up. Everything optional can stay empty — the app degrades to fewer sources rather than failing."
      />

      <MailboxSection
        mailboxes={mailboxes}
        configured={has("GOOGLE_CLIENT_ID")}
        outcome={first(params.mailbox)}
        reason={first(params.reason)}
        address={first(params.address)}
      />

      <Section title="Core" rows={core} />
      <Section
        title="Lead sources"
        rows={sources}
        footer={
          <>
            Apollo is absent on purpose: its free and Basic plans include no API
            access, and API starts at roughly $745/mo. Run{" "}
            <code className="font-mono">npm run spike:people</code> to measure
            what the configured providers actually cover.
          </>
        }
      />
    </>
  );
}

function Section({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: Row[];
  footer?: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">
        {title}
      </h2>
      <Card className="divide-y divide-border overflow-hidden p-0">
        <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.label} className="flex gap-3 px-4 py-3">
            <StatusIcon configured={row.configured} required={row.required} />
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{row.label}</p>
              <p className="text-[13px] text-muted">{row.note}</p>
            </div>
          </li>
        ))}
        </ul>
      </Card>
      {footer && <p className="mt-2 text-xs text-muted">{footer}</p>}
    </section>
  );
}

function StatusIcon({
  configured,
  required,
}: {
  configured: boolean;
  required: boolean;
}) {
  if (configured) {
    return (
      <CheckCircle2
        className="mt-0.5 h-5 w-5 shrink-0 text-success"
        aria-label="Configured"
      />
    );
  }
  // An unset optional key is not an error — the waterfall just skips it.
  return required ? (
    <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-label="Missing" />
  ) : (
    <CircleDashed
      className="mt-0.5 h-5 w-5 shrink-0 text-muted"
      aria-label="Not configured"
    />
  );
}

/** A query string value, which Next types as `string | string[] | undefined`. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The sending mailbox.
 *
 * First on the page, above the key list, because it is the one thing on this
 * screen that is not a `.env` line — it needs a person to click through
 * Google's consent screen, and until they do the product can find leads and
 * cannot contact any of them.
 *
 * The connect control is a plain `<a>` rather than a `Link`: the target is an
 * API route that answers with a redirect to Google, and a client-side
 * navigation cannot follow that off-origin.
 */
function MailboxSection({
  mailboxes,
  configured,
  outcome,
  reason,
  address,
}: {
  mailboxes: Awaited<ReturnType<typeof listConnectedMailboxes>>;
  configured: boolean;
  outcome?: string;
  reason?: string;
  address?: string;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">
        Sending mailbox
      </h2>

      {outcome === "connected" && (
        <p className="mb-3 flex items-start gap-2 rounded-[var(--radius-control)] bg-success-soft px-3 py-2 text-[13px] text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Connected {address ?? "your mailbox"}. Messages will be drafted there.
        </p>
      )}
      {outcome === "error" && (
        <p className="mb-3 flex items-start gap-2 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {reason ?? "Connecting the mailbox failed."}
        </p>
      )}

      <Card className="p-4">
        {mailboxes.length === 0 ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">No mailbox connected</p>
              <p className="mt-0.5 text-[13px] text-muted">
                {configured
                  ? "Messages are drafted into your own Gmail and wait there. Nothing " +
                    "sends on its own."
                  : "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first — see " +
                    "docs/OUTREACH.md for the Google Cloud steps."}
              </p>
            </div>
            {configured && (
              <a href="/api/v1/auth/google/start" className={buttonClass("primary")}>
                <Mail className="h-3.5 w-3.5" aria-hidden />
                Connect Gmail
              </a>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {mailboxes.map((mailbox) => (
              <li
                key={mailbox.address}
                className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{mailbox.address}</p>
                  <p className="text-[13px] text-muted">
                    {mailbox.sentToday} sent today
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!mailbox.canSend && (
                    /*
                     * The permission can be unticked on the consent screen, and
                     * the failure would otherwise appear as "sending stopped
                     * working" long after the choice that caused it.
                     */
                    <Pill tone="warning" dot>
                      Send permission missing
                    </Pill>
                  )}
                  {mailbox.isActive ? (
                    <Pill tone="success" dot>
                      Connected
                    </Pill>
                  ) : (
                    <Pill tone="danger" dot>
                      Needs reconnecting
                    </Pill>
                  )}
                  <a href="/api/v1/auth/google/start" className={buttonClass("secondary")}>
                    Reconnect
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
