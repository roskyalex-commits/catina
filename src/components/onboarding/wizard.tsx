"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, Mail, Rocket, Sparkles } from "lucide-react";
import { IcpReview } from "./icp-review";
import { LeadPreview, type PreviewLead } from "./lead-preview";
import { SignalPicker } from "./signal-picker";
import { SourcesStep } from "./sources-step";
import { Button, Card } from "@/components/ui/primitives";
import { DEFAULT_ENABLED_SIGNALS } from "@/lib/agents/schema";
import { DEMO_ICP } from "@/lib/data/demo";
import { normaliseIcpIndustries } from "@/lib/icp/normalise-industries";
import { jurisdictionFor } from "@/lib/outreach/compliance";
import type { AnalyzeResult } from "@/lib/icp/analyze";
import type { Icp } from "@/lib/icp/schema";
import { cn } from "@/lib/utils";

/**
 * Onboarding, in the five steps the reference product uses.
 *
 * Sources → Signals → Target → Preview → Outreach. The shape is deliberately
 * the competitor's, because it is the right one: it asks *what should I watch
 * for* before *who should I watch*, which is the order a seller actually thinks
 * in and the opposite of the order a database schema suggests.
 *
 * ## The draft agent
 *
 * Step 4 previews against a real sourcing run, which means an agent has to
 * exist by the end of step 3. It is created with `status: "draft"` and reused
 * on every re-run — including after the ICP is refined, when it is PATCHed
 * rather than re-created.
 *
 * That last part is not an optimisation. The free plan allows **one** agent, so
 * creating a second draft returns 402 and the preview dies on its second pass.
 * Reusing the draft is the fix; exempting drafts from the plan cap would be the
 * wrong one, because a draft that sources real leads costs exactly what a real
 * agent costs.
 */

const STEPS = ["Sources", "Signals", "Target", "Preview", "Outreach"] as const;

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

const PREVIEW_SIZE = 5;

/**
 * A stand-in for what step 1 would produce.
 *
 * `/onboarding?seed=demo` skips straight to the Signals step with a filled ICP,
 * in development only. It exists because step 1 needs `ANTHROPIC_API_KEY` and
 * the later four steps do not — without this, the only way to look at the
 * signal picker or the preview is to spend a real Claude call, which makes the
 * screens nobody can reach the screens nobody checks.
 *
 * Guarded on NODE_ENV, so a production build has no path to it at all.
 */
function seededResult(): AnalyzeResult {
  return {
    // Normalised, because `analyze.ts` normalises before it returns and a seed
    // that skipped it would show a code list the real path never produces.
    icp: normaliseIcpIndustries(DEMO_ICP).icp,
    evidence: {
      domain: "exemplu.ro",
      pagesRead: [{ url: "https://exemplu.ro/", title: "Exemplu" }],
      techStack: ["WordPress", "WooCommerce"],
      roleEmails: ["office@exemplu.ro"],
    },
  };
}

export function OnboardingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();

  /*
   * Read once, into the initial state, rather than in an effect. Seeding from
   * an effect means a first render at step 0 followed by a cascading re-render
   * at step 1 — the flash is visible, and `react-hooks/set-state-in-effect`
   * rejects it for exactly that reason.
   */
  const seed = useMemo(
    () =>
      searchParams.get("seed") === "demo" && process.env.NODE_ENV !== "production"
        ? seededResult()
        : null,
    [searchParams],
  );

  const [step, setStep] = useState(seed ? 1 : 0);
  const [result, setResult] = useState<AnalyzeResult | null>(seed);
  const [icp, setIcp] = useState<Icp | null>(seed?.icp ?? null);
  const [enabledSignals, setEnabledSignals] = useState<string[]>([
    ...DEFAULT_ENABLED_SIGNALS,
  ]);
  const [markets, setMarkets] = useState<string[]>(
    seed?.icp.countries.length ? seed.icp.countries : ["RO"],
  );
  const [name, setName] = useState(seed?.icp.productName ?? "");

  const [agentId, setAgentId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewLead[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

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

  /** The agent payload. One shape for create and for update. */
  const agentBody = useCallback(
    (current: Icp) => ({
      ...current,
      name: name.trim() || current.productName || "My first agent",
      websiteUrl:
        result?.evidence.pagesRead[0]?.url ??
        (result ? `https://${result.evidence.domain}` : ""),
      countries: markets,
      enabledSignals,
    }),
    [enabledSignals, markets, name, result],
  );

  /**
   * Create the draft once, then keep it.
   *
   * Returns the id rather than only setting state, because the caller needs it
   * in the same tick to run the preview.
   */
  const ensureAgent = useCallback(
    async (current: Icp): Promise<string | null> => {
      if (agentId) {
        await fetch(`/api/v1/agents/${agentId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(agentBody(current)),
          // A failed PATCH is not fatal: the preview still runs against the
          // targeting the agent already has, which is one refinement stale.
        }).catch(() => undefined);
        return agentId;
      }

      const response = await fetch("/api/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agentBody(current)),
      });
      const payload = (await response.json().catch(() => null)) as {
        agent?: { id: string };
        error?: string;
      } | null;

      if (!response.ok || !payload?.agent) {
        setPreviewError(
          payload?.error ?? "Could not save the agent, so there is nothing to preview yet.",
        );
        return null;
      }
      setAgentId(payload.agent.id);
      return payload.agent.id;
    },
    [agentBody, agentId],
  );

  const runPreview = useCallback(
    async (current: Icp) => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const id = await ensureAgent(current);
        if (!id) return;

        const response = await fetch("/api/v1/sourcing/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: id, limit: PREVIEW_SIZE }),
        });
        const payload = (await response.json().catch(() => null)) as {
          leads?: {
            id: string | null;
            company: string;
            person: string | null;
            title: string | null;
            score: number;
            caen: string | null;
            employeeCount: number | null;
            city: string | null;
            signals: { title: string; evidenceUrl?: string }[];
          }[];
          error?: string;
        } | null;

        if (!response.ok) {
          setPreviewError(payload?.error ?? "The preview run failed.");
          return;
        }

        setPreview(
          (payload?.leads ?? [])
            // A lead with no id cannot be given a verdict, so it is not a
            // preview card — it is a row we failed to read back.
            .filter((lead): lead is typeof lead & { id: string } => Boolean(lead.id))
            .map((lead) => ({
              id: lead.id,
              companyName: lead.company,
              personName: lead.person,
              title: lead.title,
              score: Math.round(lead.score),
              caen: lead.caen,
              employeeCount: lead.employeeCount,
              city: lead.city,
              signals: lead.signals ?? [],
              // Enrichment is a separate pass; at preview time nothing has run.
              email: null,
            })),
        );
      } catch {
        setPreviewError("Could not reach the server.");
      } finally {
        setPreviewLoading(false);
      }
    },
    [ensureAgent],
  );

  /** Step 5: promote the draft and open it. */
  async function finish() {
    if (!icp || !agentId) return;
    setLaunching(true);
    setCreateError(null);

    const response = await fetch(`/api/v1/agents/${agentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agentBody(icp)),
    }).catch(() => null);

    if (!response || !response.ok) {
      setLaunching(false);
      setCreateError("Could not save the final changes. Your agent still exists — open it and adjust there.");
      return;
    }
    router.push(`/app/agents/${agentId}`);
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
            <span className={i === step ? "font-medium" : "text-muted"}>{label}</span>
            {i < STEPS.length - 1 && (
              <span className="mx-1 hidden h-px w-4 bg-border sm:block" />
            )}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card className="p-6">
          <SourcesStep
            onResult={(next) => {
              setResult(next);
              setIcp(next.icp);
              setName(next.icp.productName ?? "My first agent");
              setMarkets(next.icp.countries.length ? next.icp.countries : ["RO"]);
              setStep(1);
            }}
          />
        </Card>
      )}

      {step === 1 && icp && (
        <Card className="p-6">
          <SignalPicker
            icp={icp}
            enabledSignals={enabledSignals}
            onChange={(next) => {
              setIcp(next.icp);
              setEnabledSignals(next.enabledSignals);
            }}
            onGenerateKeywords={async () => {
              const response = await fetch("/api/v1/icp/keywords", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  valueProp: icp.valueProp,
                  industries: icp.industries,
                  existing: icp.keywords,
                }),
              });
              if (!response.ok) throw new Error("keyword suggestion failed");
              const payload = (await response.json()) as { keywords?: string[] };
              return payload.keywords ?? [];
            }}
          />
          <StepNav
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
            nextDisabled={enabledSignals.length < 4}
            nextLabel="Continue"
          />
        </Card>
      )}

      {step === 2 && result && icp && (
        <Card className="p-6">
          <IcpReview
            result={{ ...result, icp }}
            onConfirm={(next) => {
              setIcp(next);
              setMarkets(next.countries.length ? next.countries : ["RO"]);
              setStep(3);
              void runPreview(next);
            }}
            onRestart={() => {
              setResult(null);
              setStep(0);
            }}
          />

          <section className="mt-8 border-t border-border pt-6">
            <h2 className="text-sm font-medium">Markets</h2>
            <p className="mb-3 mt-0.5 text-[13px] text-muted">
              Romania is where the free official registry data is. Other markets
              rely on the crawler and any enrichment providers you configure.
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
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
              <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-control)] bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  {strict.map((r) => r.countryName).join(", ")} require express
                  prior consent with no B2B exemption. Sourcing and drafting are
                  unaffected — you will be asked to acknowledge this once before
                  anything sends.
                </span>
              </p>
            )}
          </section>
        </Card>
      )}

      {step === 3 && icp && (
        <Card className="p-6">
          <LeadPreview
            icp={icp}
            leads={preview}
            loading={previewLoading}
            error={previewError}
            onIcpChange={(next) => setIcp(next)}
            onReject={(leadId) => {
              // Fire and forget: the verdict is training data, and losing one
              // to a flaky connection must not stall the wizard.
              void fetch(`/api/v1/leads/${leadId}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  fitFeedback: "bad",
                  status: "rejected",
                  rejectedReason: "Rejected during onboarding preview",
                }),
              }).catch(() => undefined);
            }}
            onRerun={() => void runPreview(icp)}
          />
          <StepNav
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
            nextDisabled={previewLoading}
            nextLabel="These look right"
          />
        </Card>
      )}

      {step === 4 && icp && (
        <Card className="p-6">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">
            How should it reach out?
          </h1>
          <p className="mb-5 mt-1 text-[13px] text-muted">
            Outreach sends from your own Gmail, so replies come back to you. We
            request only <code className="font-mono">gmail.send</code> and{" "}
            <code className="font-mono">gmail.compose</code> — both sensitive
            scopes, so no security audit is needed and we cannot read your mail.
          </p>

          <div className="mb-5 grid gap-2 sm:grid-cols-2">
            <div className="rounded-[var(--radius-control)] border border-border p-4 opacity-70">
              <p className="flex items-center gap-2 text-[13px] font-medium">
                <Sparkles className="h-4 w-4 text-muted" aria-hidden />
                Write with AI
              </p>
              <p className="mt-1 text-[12px] text-muted">
                Drafts a sequence from each lead&rsquo;s strongest signal. Needs a
                connected mailbox first — there is nowhere to put a draft
                otherwise.
              </p>
            </div>
            <div className="rounded-[var(--radius-control)] border border-accent bg-accent-soft p-4">
              <p className="flex items-center gap-2 text-[13px] font-medium">
                <Mail className="h-4 w-4" aria-hidden />
                Set it up myself
              </p>
              <p className="mt-1 text-[12px] text-muted">
                Creates the campaign paused, with auto-send off. Nothing leaves
                your account until you say so.
              </p>
            </div>
          </div>

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
            <Summary label="Industries">
              {icp.industryKeys.length
                ? `${icp.industryKeys.length} chosen, ${icp.caenCodes.length} CAEN codes`
                : "Any — matching on size and location"}
            </Summary>
            <Summary label="Watching for">
              {enabledSignals.length} signals
            </Summary>
            <Summary label="Markets">
              {markets.map((code) => jurisdictionFor(code).countryName).join(", ")}
            </Summary>
            <Summary label="Sends from">Not connected — drafts only</Summary>
          </dl>

          <div className="flex justify-between">
            <Button onClick={() => setStep(3)}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim() || launching || !agentId}
              onClick={finish}
            >
              <Rocket className="h-4 w-4" aria-hidden />
              {launching ? "Saving…" : "Finish"}
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

function StepNav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel,
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  nextLabel: string;
}) {
  return (
    <div className="mt-8 flex justify-between border-t border-border pt-6">
      <Button onClick={onBack}>
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back
      </Button>
      <Button variant="primary" onClick={onNext} disabled={nextDisabled}>
        {nextLabel}
      </Button>
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
