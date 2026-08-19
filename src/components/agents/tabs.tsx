"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type AgentTab = {
  href: string;
  label: string;
  count?: number;
  /** Draws the count in accent rather than grey — used for the review queue. */
  urgent?: boolean;
};

/**
 * Agent tab bar.
 *
 * Real routes rather than local state, so a tab is linkable, the browser's back
 * button works between them, and each tab's data is fetched on the server only
 * when that tab is open.
 */
export function AgentTabs({ tabs }: { tabs: AgentTab[] }) {
  const pathname = usePathname();

  return (
    <div className="scrollbar-thin -mx-4 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
      <nav className="flex min-w-max gap-1" aria-label="Agent sections">
        {tabs.map((tab, i) => {
          const active =
            pathname === tab.href || (i > 0 && pathname.startsWith(`${tab.href}/`));

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-2 px-3 py-3 text-[13px] transition",
                active
                  ? "font-medium text-foreground"
                  : "text-muted hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                    tab.urgent
                      ? "bg-accent text-accent-foreground"
                      : "bg-background text-muted",
                  )}
                >
                  {tab.count}
                </span>
              )}
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground" />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
