"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "./sidebar";
import type { ShellUser, SidebarCounts } from "./sidebar";
import { cn } from "@/lib/utils";

export const SIDEBAR_COOKIE = "catina_sidebar_collapsed";

/**
 * Owns the two pieces of chrome state: the desktop collapse and the mobile
 * drawer.
 *
 * Collapse is written to a cookie rather than localStorage so the server
 * renders the correct rail width on first paint. With localStorage the rail
 * renders expanded, hydrates, then snaps shut — visible on every navigation.
 */
export function AppShell({
  user,
  counts,
  credits,
  demo,
  defaultCollapsed,
  children,
}: {
  user: ShellUser;
  counts?: SidebarCounts;
  credits: number;
  demo: boolean;
  defaultCollapsed: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // Cookie, not localStorage — see the note above. One year, lax.
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <div className="min-h-screen">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        aria-expanded={mobileOpen}
        className="fixed left-4 top-3.5 z-30 rounded-[var(--radius-control)] border border-border bg-surface p-2 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <Sidebar
        user={user}
        counts={counts}
        credits={credits}
        demo={demo}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div
        className={cn(
          "transition-[padding] duration-200",
          collapsed ? "lg:pl-[68px]" : "lg:pl-[272px]",
        )}
      >
        {/* Full-bleed: the Contacts table is eleven columns and a centred
            max-width column would scroll it horizontally on a laptop. */}
        <main className="min-h-screen px-4 pb-12 pt-16 sm:px-6 lg:px-8 lg:pt-6">
          {children}
        </main>
      </div>
    </div>
  );
}
