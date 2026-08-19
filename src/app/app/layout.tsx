import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell, SIDEBAR_COOKIE } from "@/components/app-shell/shell";
import { getShellContext } from "@/lib/data/shell";

/**
 * Application shell: navigation rail on the left, routed content on the right.
 * Everything under /app renders inside this.
 *
 * Counts are resolved here rather than inside the sidebar so the nav stays
 * presentational and the fetch happens once per navigation, in a server
 * component.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [shell, cookieStore] = await Promise.all([getShellContext(), cookies()]);

  // Signed in but no workspace yet — the gap between confirming an email and
  // the org existing. /auth/bootstrap creates it and sends them back here.
  if (shell.needsBootstrap) redirect("/auth/bootstrap");

  const collapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "1";

  return (
    <AppShell
      user={shell.user}
      counts={shell.counts}
      credits={shell.credits}
      demo={shell.demo}
      defaultCollapsed={collapsed}
    >
      {children}
    </AppShell>
  );
}
