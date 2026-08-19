"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, ArrowLeft, Check, Mail, Rocket } from "lucide-react";
import { AnalyzeForm } from "./analyze-form";
import { IcpReview } from "./icp-review";
import { Button, Card } from "@/components/ui/primitives";
import { jurisdictionFor } from "@/lib/outreach/compliance";
import type { AnalyzeResult } from "@/lib/icp/analyze";
import type { Icp } from "@/lib/icp/schema";
import { cn } from "@/lib/utils";

const STEPS = [
  "Your website",
  "Who buys from you",
  "Where to look",
  "Connect a mailbox",
  "Launch",
] as const;

/** Markets offered up front. Romania first — it is the home market. */
const MARKETS = [
  { code: "RO", name: "Romania" },
  { code: "BG", name: "Bulgaria" },
  { code: "HU", name: "Hungary" },
  { code: "PL", name: "Poland" },
  { code: "DE", name: "Germany" },
  { code: "AT", name: "Austria" },
  { code: "NL", name: "Netherlands" },
  { code: "GB", name: "United Kingdom" },
  { code: "FR", name: "France" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "US", name: "United States" },
];

/**
 * Onboarding.
 *
 * Five steps, in the order the reference product asks them, with one addition:
 * the market step names each country's posture before anything is sourced.
 * Learning that Romania needs prior opt-in *after* an agent has queued two
 * hundred messages is the expensive way to find out.
 *
 * The final step POSTs to /api/v1/agents and opens the created agent. With no
 * Supabase project configured that call returns 401 and the error shows in
 * place — the analysis before it still runs, because it needs only a Claude
 * key.
 */
export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [icp, setIcp] = useState<Icp | null>(null);
  const [markets, setMarkets] = useState<string[]>(["RO"]);
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [launching, setLaunching] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const strict = markets
    .map(jurisdictionFor)
    .filter((rule) => rule.posture === "consent_required");

  function toggleMarket(code: string) {
    setMarkets((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  /**
   * Persist the agent, then open it.
   *
   * The corrected ICP is posted back whole — the wizard is the only place it
   * exists, and re-deriving it server-side would mean running the analysis a
   * second time and getting a different answer. Markets override
   * `icp.countries`: step 3 is the user's explicit choice and the inference is
   * a guess.
   */
  async function createAgent() {
    if (!icp || !result) return;
    setLaunching(true);
    setCreateError(null);

    try {
      const response = await fetch("/api/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...icp,
          name: name.trim(),
          websiteUrl:
            result.evidence.pagesRead[0]?.url ??
            `https://${result.evidence.domain}`,
          countries: markets,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        agent?: { id: string };
        error?: string;
      } | null;

      if (!response.ok || !payload?.agent) {
        setLaunching(false);
        setCreateError(
          payload?.error ??
            "Could not save the agent. Check your connection and try again.",
        );
        return;
      }

      router.push(`/app/agents/${payload.agent.id}`);
    } catch {
      setLaunching(false);
      setCreateError("Could not reach the server. Check your connection.");
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <ol className="mb-8 flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "grid h-6 w-6 place-items-center rounded-full text-[11px] font-medium",
                i < step
                  ? "bg-success-soft text-success"
                  : i === step
                    ? "bg-accent text-accent-foreground"
                    : "bg-background text-muted",
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={i === step ? "font-medium" : "text-muted"}>
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="mx-1 hidden h-px w-4 bg-border sm:block" />
            )}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card className="p-6">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">
            Paste your website
          </h1>
          <p className="mb-6 mt-1 text-[13px] text-muted">
            We read your homepage, about and pricing pages to work out who buys
            from you. Everything after this is a correction, not a form.
          </p>
          <AnalyzeForm
            onResult={(next) => {
              setResult(next);
              setIcp(next.icp);
              setName(next.icp.productName ?? "My first agent");
              setStep(1);
            }}
          />
        </Card>
      )}

      {step === 1 && result && (
        <Card className="p-6">
          <IcpReview
            result={result}
            onConfirm={(next) => {
              setIcp(next);
              setMarkets(next.countries.length ? next.countries : ["RO"]);
              setStep(2);
            }}
            onRestart={() => {
              setResult(null);
              setStep(0);
            }}
          />
        </Card>
      )}

      {step === 2 && (
        <Card className="p-6">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">
            Where should the agent look?
          </h1>
          <p className="mb-5 mt-1 text-[13px] text-muted">
            Romania is where the free official registry data is — CAEN codes,
            filed revenue, VAT status. Other markets rely on the crawler and any
            enrichment providers you configure.
          </p>

          <ul className="mb-5 grid gap-2 sm:grid-cols-2">
            {MARKETS.map((market) => {
              const rule = jurisdictionFor(market.code);
              const selected = markets.includes(market.code);
              return (
                <li key={market.code}>
                  <button
                    type="button"
                    onClick={() => toggleMarket(market.code)}
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-[var(--radius-control)] border px-3 py-2.5 text-left transition",
                      selected
                        ? "border-accent bg-accent-soft"
                        : "border-border hover:border-border-strong",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">
                        {market.name}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {rule.summary}
                      </span>
                    </span>
                    {rule.posture === "consent_required" && (
                      <AlertTriangle
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                        aria-label="Consent required"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {strict.length > 0 && (
            <p className="mb-5 flex items-start gap-2 rounded-[var(--radius-control)] bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {strict.map((r) => r.countryName).join(", ")} require express
                prior consent with no B2B exemption. Sourcing and drafting are
                unaffected — you will be asked to acknowledge this once before
                anything sends.
              </span>
            </p>
          )}

          <div className="flex justify-between">
            <Button onClick={() => setStep(1)}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>
            <Button
              variant="primary"
              disabled={markets.length === 0}
              onClick={() => setStep(3)}
            >
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card className="p-6">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">
            Connect a mailbox
          </h1>
          <p className="mb-5 mt-1 text-[13px] text-muted">
            Outreach sends from your own Gmail, so replies come back to you. We
            request only <code className="font-mono">gmail.send</code> and{" "}
            <code className="font-mono">gmail.compose</code> — both sensitive
            scopes, so no security audit is needed and we cannot read your mail.
          </p>

          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-border p-4">
            <Mail className="h-5 w-5 text-muted" aria-hidden />
            {mailbox ? (
              <>
                <span className="text-[13px]">{mailbox}</span>
                <Button className="ml-auto" onClick={() => setMailbox(null)}>
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <span className="text-[13px] text-muted">
                  No mailbox connected
                </span>
                <Button
                  variant="primary"
                  className="ml-auto"
                  // TODO(auth): swap for /api/v1/auth/google/start once the
                  // OAuth routes land. Skipping is a supported path, so the
                  // wizard must not depend on this.
                  disabled
                  title="Gmail OAuth lands with the persistence pass"
                >
                  Connect Gmail
                </Button>
              </>
            )}
          </div>

          <p className="mb-5 text-[13px] text-muted">
            You can skip this. The agent will still source and score leads, and
            drafts will wait until a mailbox exists.
          </p>

          <div className="flex justify-between">
            <Button onClick={() => setStep(2)}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>
            <Button variant="primary" onClick={() => setStep(4)}>
              {mailbox ? "Continue" : "Skip for now"}
            </Button>
          </div>
        </Card>
      )}

      {step === 4 && icp && (
        <Card className="p-6">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">
            Name your agent
          </h1>
          <p className="mb-5 mt-1 text-[13px] text-muted">
            You will have more than one — most people end up with an agent per
            market or per segment.
          </p>

          <label htmlFor="agent-name" className="mb-2 block text-[13px] font-medium">
            Agent name
          </label>
          <input
            id="agent-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Romania · Finance & Ops"
            className="mb-5 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2.5 text-[13px] outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-ring/50"
          />

          <dl className="mb-5 divide-y divide-border rounded-[var(--radius-control)] border border-border text-[13px]">
            <Summary label="Sells">{icp.valueProp}</Summary>
            <Summary label="Targets">{icp.targetTitles.join(", ")}</Summary>
            <Summary label="Markets">
              {markets.map((code) => jurisdictionFor(code).countryName).join(", ")}
            </Summary>
            <Summary label="CAEN codes">
              {icp.caenCodes.length ? icp.caenCodes.join(", ") : "None — non-RO targeting"}
            </Summary>
            <Summary label="Sends from">{mailbox ?? "Not connected — drafts only"}</Summary>
          </dl>

          <div className="flex justify-between">
            <Button onClick={() => setStep(3)}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim() || launching}
              onClick={createAgent}
            >
              <Rocket className="h-4 w-4" aria-hidden />
              {launching ? "Creating…" : "Create agent"}
            </Button>
          </div>

          {createError && (
            <p role="alert" className="mt-4 text-[13px] text-danger">
              {createError}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function Summary({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2.5">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
