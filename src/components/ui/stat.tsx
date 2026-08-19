import type { LucideIcon } from "lucide-react";
import { Card } from "./primitives";
import { cn } from "@/lib/utils";

/**
 * The dashboard tiles.
 *
 * `value` accepts a node so a tile with nothing to show can render an em-dash
 * with an explanation underneath rather than a zero. A zero claims a
 * measurement was taken; an em-dash says it wasn't, and several of these tiles
 * are genuinely in that state until a mailbox is connected.
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  iconTone = "accent",
  action,
  footer,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  iconTone?: "accent" | "info" | "success";
  action?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const toneClass = {
    accent: "bg-accent-soft text-accent",
    info: "bg-info-soft text-info",
    success: "bg-success-soft text-success",
  }[iconTone];

  return (
    <Card className={cn("flex flex-col p-4", className)}>
      <div className="flex items-start gap-3">
        {Icon && (
          <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[10px]", toneClass)}>
            <Icon className="h-[18px] w-[18px]" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-muted">{label}</p>
          <p className="mt-0.5 text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
            {value}
          </p>
        </div>
        {action}
      </div>

      {hint && <div className="mt-2 text-xs text-muted">{hint}</div>}
      {footer && (
        <div className="mt-auto flex flex-wrap items-center gap-4 border-t border-border pt-3 text-[13px] text-muted">
          {footer}
        </div>
      )}
    </Card>
  );
}
