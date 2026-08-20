"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { INDUSTRIES, naceLabel, resolveIndustry } from "@/lib/icp/industries";
import { normaliseIcpIndustries } from "@/lib/icp/normalise-industries";
import type { Icp } from "@/lib/icp/schema";
import { cn } from "@/lib/utils";

/**
 * Industries as a picker, CAEN codes as a consequence.
 *
 * The free-text chip input this replaces let a user type "Ecommerce" and get
 * nothing, because nothing downstream read `industries` at all — the codes came
 * from the model separately and the two could disagree silently. Choosing from
 * a fixed list means every selection resolves to real classes from the official
 * nomenclator, and the count under each row is the honest answer to "how many
 * companies will this actually match".
 *
 * The codes stay visible, in a collapsed block, because they are what the query
 * filters on and somebody debugging an empty result needs to see them. They are
 * just no longer the thing to read first.
 */
export function IndustryPicker({
  icp,
  onChange,
}: {
  icp: Icp;
  onChange: (next: Icp) => void;
}) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
    if (!needle) return INDUSTRIES;

    return INDUSTRIES.filter((industry) =>
      [industry.label, industry.labelRo, ...industry.aliases].some((phrase) =>
        phrase
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .includes(needle),
      ),
    );
  }, [query]);

  /**
   * Re-derives the codes on every toggle.
   *
   * Cheap — it is a lookup in a generated table — and it means the collapsed
   * code list below can never disagree with the chips above it. An overridden
   * list short-circuits inside `normaliseIcpIndustries`, so a user who took the
   * codes over keeps them while still editing industries freely.
   */
  function toggle(key: string) {
    const removing = icp.industryKeys.includes(key);
    const industryKeys = removing
      ? icp.industryKeys.filter((k) => k !== key)
      : [...icp.industryKeys, key];

    /*
     * Deselecting has to clear the free text too, or it does nothing at all.
     *
     * `normaliseIcpIndustries` resolves `industries` back into keys — that is
     * how a model's "E-commerce" becomes the `ecommerce` key in the first
     * place. So removing only the key leaves the phrase behind, the very next
     * normalise pass resolves it again, and the checkbox springs back on. Both
     * representations have to agree, and the click is the user saying which.
     */
    const industries = removing
      ? icp.industries.filter((text) => resolveIndustry(text) !== key)
      : icp.industries;

    onChange(normaliseIcpIndustries({ ...icp, industryKeys, industries }).icp);
  }

  function clearOverride() {
    onChange(normaliseIcpIndustries({ ...icp, caenCodesOverridden: false }).icp);
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor="industry-search" className="text-sm font-medium">
          Industries
        </label>
        <span className="text-[13px] text-muted">
          {icp.industryKeys.length} chosen
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        These become the activity codes we query the Romanian registry with.
      </p>

      <div className="relative mt-2">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          id="industry-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search industries…"
          className="w-full rounded-[var(--radius-control)] border border-border bg-surface py-2.5 pl-9 pr-3 text-[13px] outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-ring/50"
        />
      </div>

      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded-[var(--radius-control)] border border-border p-1">
        {matches.length === 0 && (
          <li className="px-2 py-3 text-[13px] text-muted">
            Nothing matches &ldquo;{query}&rdquo;. The list covers 37 segments; if
            yours is missing, leave industries empty and target on size and
            location instead.
          </li>
        )}
        {matches.map((industry) => {
          const active = icp.industryKeys.includes(industry.key);
          return (
            <li key={industry.key}>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                onClick={() => toggle(industry.key)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-[var(--radius-control)] px-2.5 py-2 text-left transition",
                  active ? "bg-accent-soft" : "hover:bg-background",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px]",
                    active
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border-strong",
                  )}
                >
                  {active ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{industry.label}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {industry.labelRo}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] text-muted">
                  {industry.naceCodes.length}{" "}
                  {industry.naceCodes.length === 1 ? "code" : "codes"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <details className="mt-3 rounded-[var(--radius-control)] border border-border p-3">
        <summary className="cursor-pointer text-[13px] text-muted">
          {icp.caenCodes.length} CAEN {icp.caenCodes.length === 1 ? "code" : "codes"}
          {icp.caenCodesOverridden ? " — edited by hand" : " — derived from those industries"}
        </summary>

        {icp.caenCodesOverridden ? (
          <div className="mt-3 space-y-2 text-[13px]">
            <p className="text-muted">
              This list is yours: changing industries above will not touch it.
            </p>
            <button
              type="button"
              onClick={clearOverride}
              className="text-accent underline underline-offset-2"
            >
              Derive them from my industries instead
            </button>
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-muted">
            Recomputed whenever you change an industry. Editing one by hand pins
            the whole list.
          </p>
        )}

        <ul className="mt-3 space-y-1">
          {icp.caenCodes.length === 0 ? (
            <li className="text-[13px] text-muted">
              None — sourcing will match on size and location alone.
            </li>
          ) : (
            icp.caenCodes.map((code) => (
              <li key={code} className="text-[12px] text-muted">
                <span className="font-mono text-foreground">{code}</span>{" "}
                {naceLabel(code) ?? "not in the nomenclator"}
              </li>
            ))
          )}
        </ul>
      </details>
    </div>
  );
}
