import Link from "next/link";
import { Flame } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { FlameCount } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------- card */

export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-border bg-surface",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover",
  secondary:
    "border border-border bg-surface text-foreground hover:border-border-strong",
  ghost: "text-muted hover:bg-background hover:text-foreground",
  danger: "bg-accent text-accent-foreground hover:bg-accent-hover",
};

export const buttonClass = (
  variant: ButtonVariant = "secondary",
  className?: string,
) =>
  cn(
    "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)]",
    "px-3.5 py-2 text-[13px] font-medium transition",
    "disabled:cursor-not-allowed disabled:opacity-50",
    BUTTON_VARIANTS[variant],
    className,
  );

export function Button({
  variant = "secondary",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={buttonClass(variant, className)} {...rest} />;
}

export function LinkButton({
  variant = "secondary",
  className,
  ...rest
}: React.ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}

/* ------------------------------------------------------------------- pills */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-background text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export function Pill({
  tone = "neutral",
  dot,
  className,
  children,
}: {
  tone?: Tone;
  /** Small leading dot, as on the Active / Ramping up indicators. */
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ avatar */

export function Avatar({
  name,
  size = 36,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");

  // Stable hue per name, so the same person keeps the same chip colour across
  // every surface without storing one.
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-medium",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `hsl(${hue} 62% 92%)`,
        color: `hsl(${hue} 48% 32%)`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

/* ------------------------------------------------------------------ flames */

/**
 * The score, as flames.
 *
 * Bands rather than a raw number, because a user acts on "worth a message" or
 * "not yet" — the difference between 71 and 74 is noise they should not be
 * invited to read into. The number stays available in the drawer.
 */
export function Flames({ count, score }: { count: FlameCount; score: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`Score ${score} of 100`}
      aria-label={`Score ${score} of 100`}
    >
      {[1, 2, 3].map((i) => (
        <Flame
          key={i}
          className={cn(
            "h-4 w-4",
            i <= count ? "fill-accent text-accent" : "text-border-strong",
          )}
          aria-hidden
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------- page header */

export function PageHeader({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div>
        <h1 className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.01em]">
          {Icon && <Icon className="h-[18px] w-[18px] text-muted" aria-hidden />}
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-[13px] text-muted">{description}</p>
        )}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </header>
  );
}

/* ------------------------------------------------------------- empty state */

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  compact,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid place-items-center rounded-[var(--radius-card)] border border-border bg-surface px-6 text-center",
        compact ? "py-10" : "py-16",
      )}
    >
      <Icon className="h-8 w-8 text-border-strong" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {children && (
        <div className="mx-auto mt-1.5 max-w-md text-[13px] text-muted">
          {children}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------- misc */

export function SectionTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[13px] text-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/** "3 hours", "a day" — the unit and count only. */
function span(seconds: number): string {
  if (seconds < 60) return "a moment";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return hours === 1 ? "an hour" : `${hours} hours`;
  const days = Math.round(seconds / 86_400);
  return days === 1 ? "a day" : `${days} days`;
}

/**
 * Relative time, phrased the way the activity feed phrases it.
 *
 * Both directions: an activity row is in the past and a scheduled launch is in
 * the future, and the same helper renders both. Singular forms are spelled out
 * ("in a day", not "in 1 days") because the plural slip is the one users
 * notice.
 */
export function relativeTime(from: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - from.getTime()) / 1000);
  if (seconds < 0) return `in ${span(Math.abs(seconds))}`;
  if (seconds < 60) return "just now";
  return `${span(seconds)} ago`;
}
