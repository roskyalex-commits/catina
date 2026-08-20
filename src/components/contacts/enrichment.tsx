"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { explainMiss } from "@/lib/enrichment/explain";
import type { WaterfallAttempt } from "@/lib/enrichment/waterfall";
import type { EmailStatus } from "@/lib/data/types";

/**
 * Shared state for the contacts screen: which rows are selected, and what
 * enrichment has come back for them.
 *
 * It lives in a provider because the two controls that need it are siblings —
 * the toolbar's bulk button and the table's per-row buttons — and the page
 * between them is a server component, so there is nowhere else to put it. The
 * alternative was a bulk button that cannot see the selection, which is how it
 * ended up inert in the first place.
 */

export type EnrichedEmail = {
  address: string;
  status: EmailStatus;
  isRoleAddress: boolean;
};

export type EnrichState =
  | { phase: "pending" }
  | { phase: "done"; email: EnrichedEmail | null; note: string; score?: number }
  | { phase: "error"; note: string };

type EnrichmentContextValue = {
  selected: Set<string>;
  toggle(id: string): void;
  toggleAll(ids: string[]): void;
  results: Record<string, EnrichState>;
  enrich(ids: string[]): void;
  running: boolean;
};

const EnrichmentContext = createContext<EnrichmentContextValue | null>(null);

export function useContactEnrichment(): EnrichmentContextValue {
  const context = useContext(EnrichmentContext);
  if (!context) {
    throw new Error("useContactEnrichment must be used inside ContactsEnrichmentProvider");
  }
  return context;
}

/**
 * Provide the context, unless an ancestor already did.
 *
 * `ContactsTable` wraps itself in this so it works wherever it is rendered.
 * Without it the table threw — "must be used inside ContactsEnrichmentProvider"
 * — on the agent's Leads tab, which renders the table on its own with no
 * toolbar beside it. A component that hard-requires a provider its own module
 * exports is a trap for the next page that reuses it, and that page crashed.
 *
 * Nesting is not a risk here, because this adds a provider only when there is
 * none. On the Contacts screen the outer provider wins and the toolbar and the
 * table keep sharing one selection; on a page with no toolbar the table gets
 * its own and there is nothing to share with.
 */
export function WithContactEnrichment({ children }: { children: React.ReactNode }) {
  const existing = useContext(EnrichmentContext);
  if (existing) return <>{children}</>;
  return <ContactsEnrichmentProvider>{children}</ContactsEnrichmentProvider>;
}

export function ContactsEnrichmentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, EnrichState>>({});
  const [running, setRunning] = useState(false);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    setSelected((current) => (current.size === ids.length ? new Set() : new Set(ids)));
  }, []);

  const enrich = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;

      setResults((current) => {
        const next = { ...current };
        for (const id of ids) next[id] = { phase: "pending" };
        return next;
      });
      setRunning(true);

      // One request per lead, in sequence. Each call crawls somebody else's
      // website; firing twenty at once is rude to them and, on a shared free
      // tier, a good way to trip a rate limit halfway through.
      void (async () => {
        for (const id of ids) {
          const state = await enrichOne(id);
          setResults((current) => ({ ...current, [id]: state }));
        }
        setRunning(false);
        // The scores changed, and they are rendered by the server component.
        router.refresh();
      })();
    },
    [router],
  );

  const value = useMemo(
    () => ({ selected, toggle, toggleAll, results, enrich, running }),
    [selected, toggle, toggleAll, results, enrich, running],
  );

  return (
    <EnrichmentContext.Provider value={value}>{children}</EnrichmentContext.Provider>
  );
}

async function enrichOne(id: string): Promise<EnrichState> {
  try {
    const response = await fetch(`/api/v1/leads/${id}/enrich`, { method: "POST" });
    const body = (await response.json()) as {
      error?: string;
      email?: EnrichedEmail | null;
      score?: { after: number };
      skipped?: string | null;
      attempts?: WaterfallAttempt[];
    };

    if (!response.ok) {
      return { phase: "error", note: body.error ?? "Enrichment failed" };
    }
    if (body.email) {
      return {
        phase: "done",
        email: body.email,
        note: "",
        score: body.score?.after,
      };
    }
    return {
      phase: "done",
      email: null,
      note: explainMiss({ skipped: body.skipped, attempts: body.attempts ?? [] }),
      score: body.score?.after,
    };
  } catch {
    return { phase: "error", note: "Could not reach the server" };
  }
}
