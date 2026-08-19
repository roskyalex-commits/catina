import Link from "next/link";
import { LogoMark, Wordmark } from "@/components/app-shell/logo";
import { OnboardingWizard } from "@/components/onboarding/wizard";

export const metadata = { title: "Set up your agent — Cătină" };

export default function OnboardingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-[60px] max-w-2xl items-center gap-2 px-6">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark />
            <Wordmark />
          </Link>
        </div>
      </header>
      <OnboardingWizard />
    </div>
  );
}
