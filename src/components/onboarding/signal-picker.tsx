"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Lock, Sparkles } from "lucide-react";
import { ChipInput } from "./chip-input";
import { Button } from "@/components/ui/primitives";
import { DETECTABLE_TECH } from "@/lib/crawl/fetch-site";
import {
  SIGNAL_CATEGORY_LABELS,
  SIGNAL_SOURCE_CATALOGUE,
  type SignalCategory,
} from "@/lib/signals/scanner";
import type { Icp } from "@/lib/icp/schema";
import { cn } from "@/lib/utils";

/**
 * Onboarding step 2 — what the agent should watch for.
 *
 * **This is the first UI that has ever written `enabledSignals`.** The column
 * has existed since the schema was laid down and every agent shipped with it
 * empty, which `selectSignalSources` reads as "run everything" — including the
 * two Google News sources that cost a request each and produced nothing across
 * 400 companies. So the picker's real job is not offering choice; it is making
 * sure the column is never empty again.
 *
 * The keyword and competitor inputs sit *above* the toggles rather than beside
 * them because they are what the two best sources read. A user who enables
 * `keyword_site` and names no keywords has enabled nothing, and the ordering is
 * what makes that obvious without a validation message.
 */

/** Gojiberry's rule, and a sound one: too few is noise, too many is everything. */
const MIN_SIGNALS = 4;
const MAX_SIGNALS = 15;

const CATEGORY_ORDER: SignalCategory[] = [
  "needs",
  "competitors",
  "registry",
  "company",
  "people",
];

export function SignalPicker({
  icp,
  enabledSignals,
  onChange,
  onGenerateKeywords,
}: {
  icp: Icp;
  enabledSignals: string[];
  onChange: (next: { icp: Icp; enabledSignals: string[] }) => void;
  /** Absent when no Anthropic key is configured — the button hides itself. */
  onGenerateKeywords?: () => Promise<string[]>;
}) {
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const byCategory = useMemo(() => {
    const groups = new Map<SignalCategory, typeof SIGNAL_SOURCE_CATALOGUE>();
    for (const entry of SIGNAL_SOURCE_CATALOGUE) {
      groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);
    }
    return groups;
  }, []);

  const selectable = SIGNAL_SOURCE_CATALOGUE.filter((entry) => entry.available);
  const chosen = enabledSignals.filter((key) =>
    selectable.some((entry) => entry.key === key),
  );

  function setIcp(patch: Partial<Icp>) {
    onChange({ icp: { ...icp, ...patch }, enabledSignals });
  }

  function toggle(key: string) {
    const next = chosen.includes(key)
      ? chosen.filter((k) => k !== key)
      : [...chosen, key];
    if (next.length > MAX_SIGNALS) return;
    onChange({ icp, enabledSignals: next });
  }

  async function generate() {
    if (!onGenerateKeywords) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const keywords = await onGenerateKeywords();
      const merged = [...icp.keywords];
      for (const keyword of keywords) {
        if (!merged.some((k) => k.toLowerCase() === keyword.toLowerCase())) {
          merged.push(keyword);
        }
      }
      // Added to what is there rather than replacing it — the user may have
      // typed the one keyword that actually matters.
      setIcp({ keywords: merged.slice(0, 20) });
    } catch {
      setGenerateError("Could not generate keywords. Add a few by hand instead.");
    } finally {
      setGenerating(false);
    }
  }

  /** Enabled but starved: the source runs and can never match anything. */
  const starved = [
    chosen.includes("keyword_site") && icp.keywords.length === 0
      ? "Keywords on their website is on, but you have named no keywords."
      : null,
    chosen.includes("keyword_news") && icp.keywords.length === 0
      ? "Keywords in the news is on, but you have named no keywords."
      : null,
    chosen.includes("competitor_tech") && icp.competitorTech.length === 0
      ? "Uses a competing product is on, but you have named no competitors we can fingerprint."
      : null,
    chosen.includes("competitor_mention") && icp.competitorNames.length === 0
      ? "Mentions a competitor is on, but you have named no text-matched competitors."
      : null,
  ].filter((message): message is string => message !== null);

  const detectable = useMemo(
    () => new Map(DETECTABLE_TECH.map((tech) => [tech.toLowerCase(), tech])),
    [],
  );

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">
          What should we watch for?
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          Every signal links back to the public page it came from, so you can
          check it before you write a word.
        </p>
      </header>

      <section className="space-y-5">
        <div>
          <ChipInput
            label="Topics your buyers care about"
            hint="Matched against a prospect's own site, whole-word and diacritic-insensitive. Their homepage is worth more than a deep page."
            values={icp.keywords}
            onChange={(v) => setIcp({ keywords: v })}
            placeholder="e-factura, magazin online…"
          />
          {onGenerateKeywords && (
            <div className="mt-2 flex items-center gap-3">
              <Button onClick={generate} disabled={generating}>
                <Sparkles className="h-4 w-4" aria-hidden />
                {generating ? "Thinking…" : "Suggest keywords"}
              </Button>
              {generateError && (
                <span role="alert" className="text-[13px] text-danger">
                  {generateError}
                </span>
              )}
            </div>
          )}
        </div>

        <CompetitorInput
          icp={icp}
          detectable={detectable}
          onChange={(patch) => setIcp(patch)}
        />
      </section>

      <section className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Signals</h2>
          <p
            className={cn(
              "text-[13px]",
              chosen.length < MIN_SIGNALS ? "text-warning" : "text-muted",
            )}
          >
            {chosen.length} of {MAX_SIGNALS} chosen
            {chosen.length < MIN_SIGNALS ? ` — pick at least ${MIN_SIGNALS}` : ""}
          </p>
        </div>

        {CATEGORY_ORDER.map((category) => {
          const entries = byCategory.get(category) ?? [];
          if (entries.length === 0) return null;

          return (
            <fieldset key={category}>
              <legend className="text-[13px] font-medium text-muted">
                {SIGNAL_CATEGORY_LABELS[category]}
              </legend>
              <ul className="mt-2 space-y-2">
                {entries.map((entry) => {
                  const active = chosen.includes(entry.key);
                  const full = !active && chosen.length >= MAX_SIGNALS;

                  return (
                    <li key={entry.key}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={active}
                        disabled={!entry.available || full}
                        onClick={() => toggle(entry.key)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-[var(--radius-control)] border px-3 py-2.5 text-left transition",
                          active
                            ? "border-accent bg-accent-soft"
                            : "border-border hover:border-border-strong",
                          (!entry.available || full) &&
                            "cursor-not-allowed opacity-60 hover:border-border",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border",
                            active
                              ? "border-accent bg-accent text-accent-foreground"
                              : "border-border-strong",
                          )}
                        >
                          {active ? "✓" : ""}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                            {entry.label}
                            {entry.romaniaOnly && (
                              <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted">
                                Romania only
                              </span>
                            )}
                            {entry.needsPreviousScan && (
                              <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted">
                                From the second scan
                              </span>
                            )}
                            {!entry.available && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-[11px] text-muted">
                                <Lock className="h-3 w-3" aria-hidden />
                                Not connected
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[13px] text-muted">
                            {entry.description}
                          </span>
                          {entry.unavailableReason && (
                            <span className="mt-1 block text-[12px] text-muted">
                              {entry.unavailableReason}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })}
      </section>

      {starved.length > 0 && (
        <div className="rounded-[var(--radius-control)] bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            These will run and never match anything
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-9">
            {starved.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * One input, two destinations.
 *
 * The user types a competitor; whether we can *fingerprint* it is a fact about
 * our crawler that they have no way to know, so the split happens here rather
 * than being asked as a question. Naming something detectable is worth saying
 * out loud — it is the difference between a 0.85 signal and a 0.5 one.
 */
function CompetitorInput({
  icp,
  detectable,
  onChange,
}: {
  icp: Icp;
  detectable: Map<string, string>;
  onChange: (patch: Partial<Icp>) => void;
}) {
  const all = [...icp.competitorTech, ...icp.competitorNames];

  function setAll(next: string[]) {
    const tech: string[] = [];
    const names: string[] = [];
    for (const value of next) {
      const known = detectable.get(value.trim().toLowerCase());
      if (known) tech.push(known);
      else names.push(value.trim());
    }
    onChange({ competitorTech: tech, competitorNames: names });
  }

  return (
    <div>
      <ChipInput
        label="Competitors"
        hint="We look for these running on a prospect's site. A company already paying for the category is the shortest path to a sale."
        values={all}
        onChange={setAll}
        placeholder="HubSpot, SmartBill…"
      />

      <p className="mt-2 text-[12px] text-muted">
        {icp.competitorTech.length > 0 && (
          <>
            <span className="font-medium text-foreground">
              {icp.competitorTech.join(", ")}
            </span>{" "}
            we can detect from a page&rsquo;s markup.{" "}
          </>
        )}
        {icp.competitorNames.length > 0 && (
          <>
            <span className="font-medium text-foreground">
              {icp.competitorNames.join(", ")}
            </span>{" "}
            we can only match as text, which is weaker — the evidence snippet
            tells you why the name is there.
          </>
        )}
        {all.length === 0 && (
          <>
            We can fingerprint {DETECTABLE_TECH.length} products from markup,
            including {DETECTABLE_TECH.slice(0, 4).join(", ")}. Anything else
            still works, as a text match.
          </>
        )}
      </p>
    </div>
  );
}
