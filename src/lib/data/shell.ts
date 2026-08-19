import { PLANS } from "@/lib/billing/limits";
import { getSessionContext } from "@/lib/supabase/server";
import { demoDataset, isDemoMode } from "./demo";
import type { ShellContext } from "./types";

/**
 * Chrome context: who is signed in, what is waiting, how many credits are left.
 *
 * Read once per navigation in the app layout, so this is on the critical path
 * for every screen — the counts are three cheap `head: true` queries rather
 * than fetching rows we then discard.
 */
export async function getShellContext(): Promise<
  ShellContext & { needsBootstrap?: boolean }
> {
  if (isDemoMode()) {
    const { contacts, agents } = demoDataset();
    return {
      user: { name: "Alex", email: "you@catina.ro" },
      counts: {
        newLeads: contacts.filter((c) => c.fitFeedback === null).length,
        pendingDrafts: agents.reduce((sum, a) => sum + a.queue.length, 0),
      },
      credits: PLANS.free.maxEnrichmentsPerMonth,
      demo: true,
    };
  }

  const session = await getSessionContext();

  // The proxy guarantees a session on /app, so this only fires in the gap
  // between confirming an email and the workspace existing.
  if (!session) {
    return { user: { name: "You", email: "" }, counts: {}, credits: 0, demo: false };
  }

  const email = session.user.email ?? "";
  const user = { name: displayName(session.user, email), email };

  if (!session.orgId) {
    return { user, counts: {}, credits: 0, demo: false, needsBootstrap: true };
  }

  const { supabase, orgId } = session;

  const [newLeads, pendingDrafts, usage] = await Promise.all([
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "new"),
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("state", "drafted"),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .not("email_id", "is", null),
  ]);

  const limits = PLANS.free;

  return {
    user,
    counts: {
      newLeads: newLeads.count ?? 0,
      pendingDrafts: pendingDrafts.count ?? 0,
    },
    // Credits are enrichments left this month — the only metered resource, and
    // an enriched lead is one that spent one.
    credits: Math.max(0, limits.maxEnrichmentsPerMonth - (usage.count ?? 0)),
    demo: false,
  };
}

function displayName(
  user: { user_metadata?: Record<string, unknown> },
  email: string,
): string {
  const metadata = user.user_metadata ?? {};
  for (const key of ["full_name", "name", "user_name"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const local = email.split("@")[0] ?? "You";
  return local.charAt(0).toUpperCase() + local.slice(1);
}
