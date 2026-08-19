import Link from "next/link";
import { LogoMark, Wordmark } from "@/components/app-shell/logo";
import { Card } from "@/components/ui/primitives";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <Link href="/" className="mb-6 flex items-center gap-2">
        <LogoMark />
        <Wordmark />
      </Link>
      <Card className="w-full max-w-sm p-6">{children}</Card>
    </main>
  );
}
