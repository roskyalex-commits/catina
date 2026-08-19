"use client";

import { useState } from "react";
import type { AnalyzeResult } from "@/lib/icp/analyze";

/**
 * Onboarding step 1: the single URL input the whole funnel hangs off.
 *
 * Deliberately one field and one button. Gojiberry's conversion comes from the
 * user seeing a real ICP appear seconds after pasting their homepage, so
 * anything that delays that moment belongs on a later screen.
 */
export function AnalyzeForm({
  onResult,
}: {
  onResult: (result: AnalyzeResult) => void;
}) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || status === "loading") return;

    setStatus("loading");
    setError(null);

    try {
      const response = await fetch("/api/v1/icp/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Something went wrong. Try again.");
        setStatus("error");
        return;
      }
      onResult(payload as AnalyzeResult);
      setStatus("idle");
    } catch {
      setError("Could not reach the server. Check your connection.");
      setStatus("error");
    }
  }

  const loading = status === "loading";

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <label htmlFor="site-url" className="block text-sm font-medium mb-2">
        Your website
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="site-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="catina.ro"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          aria-describedby={error ? "site-url-error" : undefined}
          aria-invalid={status === "error"}
          className="flex-1 rounded-lg border border-border bg-surface px-4 py-3 text-base
                     outline-none transition focus:border-accent
                     focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="rounded-lg bg-accent px-6 py-3 text-base font-medium
                     text-accent-foreground transition hover:opacity-90
                     disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Reading your site…" : "Find my buyers"}
        </button>
      </div>

      <p className="mt-3 text-sm text-muted">
        We read your homepage to work out who you sell to. No signup yet.
      </p>

      {error && (
        <p id="site-url-error" role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      {loading && <AnalysisProgress />}
    </form>
  );
}

/**
 * The analysis takes a few seconds and produces nothing until it is done, so
 * this stands in for real progress. The steps are honest about what the server
 * is doing, in order — they are not a fake loading bar.
 */
function AnalysisProgress() {
  return (
    <ul className="mt-6 space-y-2 text-sm text-muted" aria-live="polite">
      {[
        "Fetching your homepage, about and pricing pages",
        "Working out what you sell and to whom",
        "Matching your buyers to CAEN industry codes",
      ].map((step, i) => (
        <li key={step} className="flex items-center gap-3">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
            style={{
              animation: `pulse 1.4s ease-in-out ${i * 0.25}s infinite`,
            }}
          />
          {step}
        </li>
      ))}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.25; }
          50% { opacity: 1; }
        }
      `}</style>
    </ul>
  );
}
