"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Database,
  FlaskConical,
  LogOut,
  Video,
  X,
} from "lucide-react";
import { NAV_FOOTER_ITEMS, NAV_ITEMS, activeNavItem } from "./nav";
import { LogoMark, Wordmark } from "./logo";
import type { NavItem } from "./nav";
import { cn } from "@/lib/utils";

export type SidebarCounts = Partial<
  Record<"newLeads" | "pendingDrafts" | "unreadReplies", number>
>;

export type ShellUser = {
  name: string;
  email: string;
};

/**
 * Left navigation rail.
 *
 * Fixed on desktop, off-canvas drawer below `lg`. Collapsing to an icon rail is
 * a real requirement rather than polish: the Contacts table is eleven columns
 * wide and needs the horizontal space back on a laptop screen.
 *
 * The collapsed flag is owned by `AppShell` and persisted in a cookie, so the
 * server renders the correct width and the rail does not flash open on reload.
 */
export function Sidebar({
  user,
  counts = {},
  credits,
  demo,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onCloseMobile,
}: {
  user: ShellUser;
  counts?: SidebarCounts;
  credits: number;
  /** True while the app renders fixtures because no database is configured. */
  demo: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const pathname = usePathname();
  const active = activeNavItem(pathname);

  return (
    <>
      {mobileOpen && (
        <div
          role="presentation"
          onClick={onCloseMobile}
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
        />
      )}

      <nav
        aria-label="Main"
        data-collapsed={collapsed || undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-surface",
          "transition-[width,transform] duration-200 lg:translate-x-0",
          collapsed ? "w-[68px]" : "w-[272px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          className={cn(
            "flex h-[60px] shrink-0 items-center gap-2 px-4",
            collapsed && "justify-center px-0",
          )}
        >
          <Link
            href="/app"
            onClick={onCloseMobile}
            className="flex items-center gap-2"
            aria-label="Cătină home"
          >
            <LogoMark />
            {!collapsed && <Wordmark />}
          </Link>

          {!collapsed && (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label="Notifications"
                className="relative rounded-md p-1.5 text-muted transition hover:bg-background hover:text-foreground"
              >
                <Bell className="h-[18px] w-[18px]" aria-hidden />
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
              </button>
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label="Collapse sidebar"
                className="hidden rounded-md p-1.5 text-muted transition hover:bg-background hover:text-foreground lg:block"
              >
                <ChevronLeft className="h-[18px] w-[18px]" aria-hidden />
              </button>
              <button
                type="button"
                onClick={onCloseMobile}
                aria-label="Close navigation"
                className="rounded-md p-1.5 text-muted transition hover:text-foreground lg:hidden"
              >
                <X className="h-[18px] w-[18px]" aria-hidden />
              </button>
            </div>
          )}
        </div>

        {collapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand sidebar"
            className="mx-auto mb-2 hidden rounded-md p-1.5 text-muted transition hover:bg-background hover:text-foreground lg:block"
          >
            <ChevronRight className="h-[18px] w-[18px]" aria-hidden />
          </button>
        )}

        <div className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-4">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <NavLink
                  item={item}
                  isActive={active?.href === item.href}
                  badge={item.badgeKey ? counts[item.badgeKey] : undefined}
                  collapsed={collapsed}
                  onNavigate={onCloseMobile}
                />
              </li>
            ))}
          </ul>
        </div>

        {!collapsed && (
          <Link
            href="/app/help"
            onClick={onCloseMobile}
            className="mx-3 mb-3 flex items-center gap-3 rounded-[var(--radius-card)] bg-accent-soft p-3 transition hover:brightness-[0.98]"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface">
              <Video className="h-[18px] w-[18px] text-accent" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-tight">
                Register for Live Session
              </span>
              <span className="block truncate text-xs text-muted">
                Join our next webinar
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </Link>
        )}

        <div className="px-3 pb-2">
          <ul className="space-y-0.5">
            {NAV_FOOTER_ITEMS.map((item) => (
              <li key={item.href}>
                <NavLink
                  item={item}
                  isActive={active?.href === item.href}
                  collapsed={collapsed}
                  onNavigate={onCloseMobile}
                  subdued
                />
              </li>
            ))}
          </ul>
        </div>

        {demo && (
          <div
            className={cn(
              "flex items-center gap-2.5 border-t border-border bg-warning-soft px-4 py-2.5 text-[13px] text-warning",
              collapsed && "justify-center px-0",
            )}
            title="Sample data — no database is configured yet"
          >
            <FlaskConical className="h-[18px] w-[18px] shrink-0" aria-hidden />
            {!collapsed && <span>Demo data</span>}
          </div>
        )}

        <div
          className={cn(
            "flex items-center gap-2.5 border-t border-border px-4 py-2.5 text-[13px] text-muted",
            collapsed && "justify-center px-0",
          )}
          title={collapsed ? `${credits} credits` : undefined}
        >
          <Database className="h-[18px] w-[18px] shrink-0" aria-hidden />
          {!collapsed && (
            <span>
              <span className="tabular-nums text-foreground">{credits}</span>{" "}
              Credits
            </span>
          )}
        </div>

        <div
          className={cn(
            "flex items-center gap-3 border-t border-border px-4 py-3",
            collapsed && "justify-center px-0",
          )}
          title={collapsed ? `${user.name} · ${user.email}` : undefined}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-sm font-medium text-accent-foreground">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-tight">
                  {user.name}
                </span>
                <span className="block truncate text-xs text-muted">
                  {user.email}
                </span>
              </span>

              {/* A form, not a link: signing out is a POST so a prefetch or a
                  link scanner cannot end the session. */}
              <form action="/auth/signout" method="post">
                <button
                  type="submit"
                  aria-label="Sign out"
                  title="Sign out"
                  className="rounded-md p-1.5 text-muted transition hover:bg-background hover:text-foreground"
                >
                  <LogOut className="h-4 w-4" aria-hidden />
                </button>
              </form>
            </>
          )}
        </div>
      </nav>
    </>
  );
}

function NavLink({
  item,
  isActive,
  badge,
  collapsed,
  onNavigate,
  subdued,
}: {
  item: NavItem;
  isActive: boolean;
  badge?: number;
  collapsed: boolean;
  onNavigate: () => void;
  subdued?: boolean;
}) {
  const Icon = item.icon;
  const showBadge = badge !== undefined && badge > 0;

  return (
    <Link
      href={item.href}
      // Closed on click rather than on a pathname effect: otherwise tapping a
      // link on a phone leaves the drawer covering the content just requested.
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center rounded-[10px] text-[14px] transition",
        collapsed ? "h-10 justify-center" : "h-10 gap-3 px-3",
        subdued ? "text-[13px]" : "",
        isActive
          ? "bg-accent-soft font-medium text-foreground"
          : "text-muted hover:bg-background hover:text-foreground",
      )}
    >
      <span className="relative shrink-0">
        <Icon
          className={cn(
            "h-[18px] w-[18px]",
            isActive && "text-accent",
          )}
          aria-hidden
        />
        {collapsed && showBadge && (
          <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent" />
        )}
      </span>

      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.tag && (
            <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
              {item.tag}
            </span>
          )}
          {showBadge && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-accent-foreground">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </>
      )}
    </Link>
  );
}
