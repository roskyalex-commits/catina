"use client";

import { useState } from "react";
import { ChipInput } from "./chip-input";
import type { AnalyzeResult } from "@/lib/icp/analyze";
import {
  COMPANY_TYPE_LABELS,
  SENIORITIES,
  SENIORITY_LABELS,
  type Icp,
} from "@/lib/icp/schema";

/**
 * Onboarding steps 2 and 3: confirm the inferred ICP, then pick markets.
 *
 * Everything here is pre-filled from the model. The user's job is to correct,
 * not to author — so low-confidence inferences and stated assumptions are
 * surfaced up front rather than buried, and the evidence panel links back to
 * the pages the inference was drawn from.
 */
export function IcpReview({
  result,
  onConfirm,
  onRestart,
}: {
  result: AnalyzeResult;
  onConfirm: (icp: Icp) => void;
  onRestart: () => void;
}) {
  const [icp, setIcp] = useState<Icp>(result.icp);

  function update<K extends keyof Icp>(key: K, value: Icp[K]) {
    setIcp((prev) => ({ ...prev, [key]: value }));
  }

  const lowConfidence = icp.confidence < 0.6;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted">
          Read {result.evidence.pagesRead.length}{" "}
          {result.evidence.pagesRead.length === 1 ? "page" : "pages"} from{" "}
          <span className="font-medium text-foreground">
            {result.evidence.domain}
          </span>
        </p>
        <h2 className="mt-1 text-2xl font-semibold">Here&rsquo;s who you sell to</h2>
        <p className="mt-2 text-muted">{icp.valueProp}</p>
      </header>

      {(lowConfidence || icp.assumptions.length > 0) && (
        <div className="rounded-lg border border-border bg-accent-soft p-4">
          <p className="text-sm font-medium">
            {lowConfidence
              ? "Your site didn't say much, so a lot of this is inferred"
              : "A few things we guessed"}
          </p>
          {icp.assumptions.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {icp.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-sm text-muted">
            Worth a look before the agent starts.
          </p>
        </div>
      )}

      <section className="space-y-5">
        <ChipInput
          label="Job titles to target"
          hint="The people who actually sign off on buying this."
          values={icp.targetTitles}
          onChange={(v) => update("targetTitles", v)}
          placeholder="Director General, CMO…"
        />

        <fieldset>
          <legend className="text-sm font-medium">Seniority</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {SENIORITIES.map((level) => {
              const active = icp.targetSeniorities.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    update(
                      "targetSeniorities",
                      active
                        ? icp.targetSeniorities.filter((s) => s !== level)
                        : [...icp.targetSeniorities, level],
                    )
                  }
                  className={`rounded-md border px-3 py-1.5 text-sm transition ${
                    active
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border bg-surface hover:border-accent"
                  }`}
                >
                  {SENIORITY_LABELS[level]}
                </button>
              );
            })}
          </div>
        </fieldset>

        <ChipInput
          label="Industries"
          values={icp.industries}
          onChange={(v) => update("industries", v)}
          placeholder="E-commerce, Logistics…"
        />

        <ChipInput
          label="CAEN codes"
          hint="Romanian activity codes. These query the national company registry directly — the sharpest filter available for Romanian leads."
          values={icp.caenCodes}
          onChange={(v) => update("caenCodes", v)}
          placeholder="4791"
          validate={(v) =>
            /^\d{4}$/.test(v) ? null : "A CAEN code is exactly 4 digits."
          }
        />

        <ChipInput
          label="Markets"
          hint="Two-letter country codes. Romanian leads get different outreach rules — see below."
          values={icp.countries}
          onChange={(v) =>
            update(
              "countries",
              v.map((c) => c.toUpperCase()),
            )
          }
          placeholder="RO, DE, GB"
          validate={(v) =>
            /^[A-Za-z]{2}$/.test(v) ? null : "Use a 2-letter country code."
          }
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Min employees"
            value={icp.employeeMin}
            onChange={(v) => update("employeeMin", v)}
          />
          <NumberField
            label="Max employees"
            value={icp.employeeMax}
            onChange={(v) => update("employeeMax", v)}
          />
        </div>

        {icp.countries.includes("RO") && (
          <div>
            <p className="text-sm font-medium">Revenue band (RON)</p>
            <p className="mt-0.5 text-xs text-muted">
              From ANAF&rsquo;s annual filings — official, and unavailable to any
              international prospecting tool. Leave blank for any size.
            </p>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Min revenue"
                value={icp.revenueMinRon}
                onChange={(v) => update("revenueMinRon", v)}
              />
              <NumberField
                label="Max revenue"
                value={icp.revenueMaxRon}
                onChange={(v) => update("revenueMaxRon", v)}
              />
            </div>
          </div>
        )}

        <ChipInput
          label="Keywords"
          values={icp.keywords}
          onChange={(v) => update("keywords", v)}
          placeholder="facturare, e-factura…"
        />

        <ChipInput
          label="Exclude"
          hint="Competitors, bad-fit verticals, customers you already have."
          values={icp.exclusions}
          onChange={(v) => update("exclusions", v)}
          placeholder="Enterprise ERP vendors…"
        />
      </section>

      {icp.countries.includes("RO") && <RomanianComplianceNotice />}

      {icp.companyTypes.length > 0 && (
        <p className="text-sm text-muted">
          Company types:{" "}
          {icp.companyTypes.map((t) => COMPANY_TYPE_LABELS[t]).join(", ")}
        </p>
      )}

      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium">
          What we read to work this out
        </summary>
        <ul className="mt-3 space-y-1 text-sm">
          {result.evidence.pagesRead.map((page) => (
            <li key={page.url}>
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent underline underline-offset-2"
              >
                {page.title}
              </a>
            </li>
          ))}
        </ul>
        {result.evidence.techStack.length > 0 && (
          <p className="mt-3 text-sm text-muted">
            Tech detected: {result.evidence.techStack.join(", ")}
          </p>
        )}
      </details>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => onConfirm(icp)}
          className="rounded-lg bg-accent px-6 py-3 font-medium text-accent-foreground
                     transition hover:opacity-90"
        >
          Looks right — find these leads
        </button>
        <button
          type="button"
          onClick={onRestart}
          className="rounded-lg border border-border px-6 py-3 transition hover:border-accent"
        >
          Try another site
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        type="number"
        min={0}
        value={value ?? ""}
        placeholder="Any"
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2
                   outline-none transition focus:border-accent focus:ring-2
                   focus:ring-accent/30"
      />
    </label>
  );
}

/**
 * Romania has no B2B exemption for cold email: Law 506/2004 requires express
 * prior opt-in, with ANSPDCP fines of RON 5,000–100,000 (or up to 2% of
 * turnover above RON 5M). Surfaced here, at ICP time, so the user knows before
 * building a list rather than after.
 */
function RomanianComplianceNotice() {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-sm font-medium">Romanian leads: email needs opt-in</p>
      <p className="mt-1 text-sm text-muted">
        Unlike the UK or the Netherlands, Romania has no B2B exemption for cold
        email — Law 506/2004 requires prior consent, and ANSPDCP fines run from
        RON 5,000 to RON 100,000. We&rsquo;ll flag every Romanian lead and default
        them to review-before-send. You can still send; the choice stays yours.
      </p>
    </div>
  );
}
