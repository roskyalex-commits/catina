import {
  BarChart3,
  Gift,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  CircleHelp,
  Settings,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Sidebar navigation, defined once so the rail, the mobile drawer and the
 * page-title lookup cannot drift apart.
 *
 * Flat, not grouped. The previous Sourcing/Outreach headings described how the
 * system works; this list describes what the user came to do, which is the
 * order the reference product uses. Three of the old entries folded in rather
 * than disappeared:
 *
 *   Ideal customer -> the Agent owns its own targeting (Sources tab)
 *   Companies      -> a tab under Contacts
 *   Signals        -> the SIGNAL column and the contact drawer, where a signal
 *                     is actually useful, instead of a list nobody opens
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Small pill after the label, e.g. "Beta". */
  tag?: string;
  /** Shown in the rail when there is something waiting. */
  badgeKey?: "newLeads" | "pendingDrafts" | "unreadReplies";
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/app", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/ask", label: "Ask", icon: Sparkles, tag: "Beta" },
  { href: "/app/agents", label: "Agents", icon: Workflow },
  { href: "/app/contacts", label: "Contacts", icon: Users, badgeKey: "newLeads" },
  { href: "/app/inbox", label: "Inbox", icon: Inbox, badgeKey: "unreadReplies" },
  { href: "/app/insights", label: "Insights", icon: BarChart3 },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

/** Secondary links pinned above the account block. */
export const NAV_FOOTER_ITEMS: NavItem[] = [
  { href: "/app/help", label: "Help Center", icon: CircleHelp },
  { href: "/app/roadmap", label: "Roadmap & Ideas", icon: Lightbulb },
  { href: "/app/referral", label: "Join Referral program", icon: Gift },
];

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_ITEMS, ...NAV_FOOTER_ITEMS];

/**
 * Longest-prefix match, so /app/agents/123 resolves to the Agents item while
 * /app itself does not swallow every child route.
 */
export function activeNavItem(pathname: string): NavItem | undefined {
  return ALL_NAV_ITEMS.filter(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  ).sort((a, b) => b.href.length - a.href.length)[0];
}
