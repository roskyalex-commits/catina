"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/lib/utils";

/**
 * Range selector.
 *
 * Writes to the query string rather than component state, so the choice
 * survives a reload, can be linked to, and is readable by the server component
 * that fetches the data. The pending transition keeps the old numbers on screen
 * while the new ones load instead of flashing an empty chart.
 */
export function Segmented<T extends string>({
  param,
  value,
  options,
  className,
}: {
  param: string;
  value: T;
  options: { value: T; label: string }[];
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function select(next: T) {
    if (next === value) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(param, next);
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  return (
    <div
      role="group"
      aria-label="Date range"
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-surface p-1 ring-1 ring-border",
        pending && "opacity-70",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => select(option.value)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-[13px] font-medium transition",
              active
                ? "bg-foreground text-background"
                : "text-muted hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
