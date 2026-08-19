"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { CircleAlert, Loader2, MailCheck } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";

const COPY = {
  login: {
    title: "Sign in",
    submit: "Sign in",
    switchPrompt: "New here?",
    switchLabel: "Create an account",
    switchHref: "/signup",
  },
  signup: {
    title: "Create your workspace",
    submit: "Create account",
    switchPrompt: "Already have an account?",
    switchLabel: "Sign in",
    switchHref: "/login",
  },
} as const;

/**
 * Email + password auth.
 *
 * Runs in the browser so `@supabase/ssr` writes the session cookies itself,
 * then hands off to /auth/bootstrap with a full navigation rather than a
 * client-side push — the server needs to read cookies that were only just set,
 * and a soft navigation can be served from the router cache.
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const copy = COPY[mode];
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(searchParams.get("error"));
  const [checkEmail, setCheckEmail] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    let supabase;
    try {
      supabase = createSupabaseBrowserClient();
    } catch {
      setError(
        "Supabase isn't configured. Add NEXT_PUBLIC_SUPABASE_URL and " +
          "NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local and restart the dev server.",
      );
      setPending(false);
      return;
    }

    const destination = `/auth/bootstrap${next ? `?next=${encodeURIComponent(next)}` : ""}`;

    if (mode === "signup") {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback${
            next ? `?next=${encodeURIComponent(next)}` : ""
          }`,
        },
      });

      if (signUpError) {
        setError(signUpError.message);
        setPending(false);
        return;
      }

      // With email confirmation on, signUp returns a user but no session. With
      // it off, the session is live immediately and we can go straight in.
      if (!data.session) {
        setCheckEmail(true);
        setPending(false);
        return;
      }

      // Full navigation, not router.push: the destination is a Route Handler,
      // not a page, so there is no RSC payload for the router to fetch — and
      // the server has to read session cookies the Supabase client set moments
      // ago, which a cached soft navigation can miss.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(destination);
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setPending(false);
      return;
    }

    // See the note above: Route Handler destination, freshly written cookies.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(destination);
  }

  if (checkEmail) {
    return (
      <div className="text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-success-soft text-success">
          <MailCheck className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-3 text-xl font-semibold tracking-[-0.01em]">
          Confirm your email
        </h1>
        <p className="mt-2 text-[13px] text-muted">
          We sent a link to <span className="font-medium text-foreground">{email}</span>.
          Open it and you&rsquo;ll land straight in your workspace.
        </p>
        <p className="mt-4 rounded-[var(--radius-control)] bg-background px-3 py-2.5 text-left text-xs text-muted">
          Developing locally? Supabase&rsquo;s built-in mailer is rate-limited to
          a few messages an hour. Turn off{" "}
          <span className="font-medium text-foreground">Confirm email</span> under
          Authentication → Sign In / Providers → Email, and sign up again to skip
          this step.
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{copy.title}</h1>
      <p className="mt-1 text-[13px] text-muted">
        {mode === "signup"
          ? "One account, one workspace. You can rename it later."
          : "Welcome back."}
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-[13px] font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
            className="w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2.5 text-[13px] outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-ring/50 disabled:opacity-60"
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-[13px] font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            className="w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2.5 text-[13px] outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-ring/50 disabled:opacity-60"
          />
          {mode === "signup" && (
            <p className="mt-1.5 text-xs text-muted">At least 8 characters.</p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2.5 text-[13px] text-danger"
          >
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 py-2.5 text-[13px] font-medium text-accent-foreground transition hover:bg-accent-hover disabled:opacity-60"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? "Working…" : copy.submit}
        </button>
      </form>

      <p className="mt-5 text-center text-[13px] text-muted">
        {copy.switchPrompt}{" "}
        <Link href={copy.switchHref} className="text-accent underline underline-offset-2">
          {copy.switchLabel}
        </Link>
      </p>
    </>
  );
}
