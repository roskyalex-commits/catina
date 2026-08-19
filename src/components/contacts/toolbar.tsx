"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ChevronDown, Download, ListPlus, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/primitives";

/**
 * Search runs through the query string so the server component does the
 * filtering — the same predicate that will become a `where` clause. Debounced,
 * because every keystroke would otherwise be a round trip.
 */
export function ContactsToolbar({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (value === initialQuery) return;

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) params.set("q", value.trim());
      else params.delete("q");
      params.delete("page");
      startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
    }, 250);

    return () => clearTimeout(timer);
  }, [value, initialQuery, pathname, router, searchParams]);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="relative min-w-64 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search by name, email, company, location, job title, website, or industry"
          aria-label="Search contacts"
          className="w-full rounded-[var(--radius-control)] border border-border bg-surface py-2 pl-9 pr-3 text-[13px] outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent-ring/50"
        />
      </div>

      <button
        type="button"
        className="text-[13px] text-muted transition hover:text-foreground"
      >
        Add more filters »
      </button>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button>
          <ListPlus className="h-4 w-4" aria-hidden />
          Add to list
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button>
          <Download className="h-4 w-4" aria-hidden />
          Export to…
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button>
          <Sparkles className="h-4 w-4" aria-hidden />
          Enrich Email
        </Button>
      </div>
    </div>
  );
}
