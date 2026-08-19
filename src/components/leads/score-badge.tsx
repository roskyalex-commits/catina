import type { ScoreBreakdown } from "@/lib/signals/scoring";
import { cn } from "@/lib/utils";

/**
 * Score display.
 *
 * Bands rather than a raw gradient, because a user acts on "worth a message"
 * versus "not yet" — the difference between 71 and 74 is noise they should not
 * be invited to read into.
 */
export function ScoreBadge({
  score,
  disqualified,
}: {
  score: number;
  disqualified?: boolean;
}) {
  if (disqualified) {
    return (
      <span className="inline-flex min-w-11 justify-center rounded-md border border-border px-2 py-1 text-sm text-muted line-through">
        {score}
      </span>
    );
  }

  const band =
    score >= 70
      ? "border-transparent bg-accent text-accent-foreground"
      : score >= 40
        ? "border-accent bg-accent-soft text-foreground"
        : "border-border bg-surface text-muted";

  return (
    <span
      className={cn(
        "inline-flex min-w-11 justify-center rounded-md border px-2 py-1 text-sm font-medium tabular-nums",
        band,
      )}
    >
      {score}
    </span>
  );
}

/**
 * The full explanation.
 *
 * This is the product's answer to "why is this lead at the top", and the
 * reason the scorer returns a breakdown at all. Components are shown with
 * their weights so the arithmetic is checkable rather than asserted.
 */
export function ScoreExplanation({ breakdown }: { breakdown: ScoreBreakdown }) {
  if (breakdown.disqualified) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="text-sm font-medium text-danger">Not contactable</p>
        <p className="mt-1 text-sm text-muted">{breakdown.disqualified}</p>
      </div>
    );
  }

  const components = [
    { name: "Fit", ...breakdown.icpFit },
    { name: "Signals", ...breakdown.signals },
    { name: "Reachable", ...breakdown.contactability },
  ];

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
      {components.map((component) => (
        <section key={component.name}>
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-medium">{component.name}</h4>
            <span className="text-xs tabular-nums text-muted">
              {Math.round(component.score * 100)} × {component.weight.toFixed(2)}
            </span>
          </div>
          <ul className="mt-1.5 space-y-1">
            {component.reasons.map((reason, i) => (
              <li
                key={`${reason.label}-${i}`}
                className="flex items-start justify-between gap-3 text-sm"
              >
                <span
                  className={reason.points > 0 ? "text-foreground" : "text-muted"}
                >
                  {reason.label}
                </span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums text-xs",
                    reason.points > 0 ? "text-success" : "text-muted",
                  )}
                >
                  {reason.points > 0 ? "+" : ""}
                  {Math.round(reason.points * 100)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {breakdown.penalties.reasons.length > 0 && (
        <section>
          <h4 className="text-sm font-medium text-danger">Penalties</h4>
          <ul className="mt-1.5 space-y-1">
            {breakdown.penalties.reasons.map((reason, i) => (
              <li
                key={`${reason.label}-${i}`}
                className="flex items-start justify-between gap-3 text-sm text-muted"
              >
                <span>{reason.label}</span>
                <span className="shrink-0 tabular-nums text-xs text-danger">
                  {Math.round(reason.points * 100)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-baseline justify-between border-t border-border pt-3">
        <span className="text-sm font-medium">Total</span>
        <span className="text-lg font-semibold tabular-nums">{breakdown.total}</span>
      </div>
    </div>
  );
}
