"use client";

import { Globe, Lock, Sparkles, Upload, Users } from "lucide-react";
import { AnalyzeForm } from "./analyze-form";
import type { AnalyzeResult } from "@/lib/icp/analyze";
import { cn } from "@/lib/utils";

/**
 * Onboarding step 1 — where the agent's leads come from.
 *
 * One source works. The other three are rendered as disabled cards carrying the
 * reason, which is a deliberate choice rather than an unfinished screen: a user
 * comparing this to the reference product will look for exactly these four, and
 * a missing option reads as "cannot", while a disabled one with a sentence
 * under it reads as "not yet, and here is why".
 *
 * The LinkedIn card is where the deliberate absence gets explained once, in
 * full, so it does not have to be repeated on every screen that touches it.
 */
export function SourcesStep({
  onResult,
}: {
  onResult: (result: AnalyzeResult) => void;
}) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">
          Where should we look for buyers?
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          Start with your own website. We read it to work out who buys from you,
          and everything after this is a correction rather than a form.
        </p>
      </header>

      <div className="rounded-[var(--radius-control)] border border-accent bg-accent-soft p-4">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <Sparkles className="h-4 w-4" aria-hidden />
          High-intent signals from the Romanian registry
        </p>
        <p className="mt-1 text-[13px] text-muted">
          Companies matched on what they need, what they run, and what they have
          filed — official data no international tool has.
        </p>
        <div className="mt-4">
          <AnalyzeForm onResult={onResult} />
        </div>
      </div>

      <ul className="grid gap-2 sm:grid-cols-3">
        <SourceCard
          icon={Users}
          title="Warm lookalikes"
          reason="Needs customers already in the workspace to look like. Available once you have imported or closed some."
        />
        <SourceCard
          icon={Upload}
          title="Import a list"
          reason="CSV import lands with the contacts work. Nothing about it is blocked — it is simply not built yet."
        />
        <SourceCard
          icon={Globe}
          title="LinkedIn"
          reason="Engagement data needs a paid LinkedIn API or a terms-violating scraper. Everything behind it is built and waiting for a key; until then we match the same intent from official EU sources."
        />
      </ul>
    </div>
  );
}

function SourceCard({
  icon: Icon,
  title,
  reason,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  reason: string;
}) {
  return (
    <li
      className={cn(
        "rounded-[var(--radius-control)] border border-border p-3 opacity-70",
      )}
    >
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <Icon className="h-4 w-4 text-muted" aria-hidden />
        {title}
        <Lock className="ml-auto h-3 w-3 text-muted" aria-hidden />
      </p>
      <p className="mt-1 text-[12px] text-muted">{reason}</p>
    </li>
  );
}
