"use client";

import { useState } from "react";

/**
 * Editable list of short strings — titles, industries, keywords, exclusions.
 *
 * Every ICP array field is edited the same way, so this exists once rather
 * than five times. Enter and comma both commit, because users paste
 * comma-separated lists out of a spreadsheet as often as they type.
 */
export function ChipInput({
  label,
  hint,
  values,
  onChange,
  placeholder,
  validate,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Return an error string to reject the entry, or null to accept it. */
  validate?: (value: string) => string | null;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function commit(raw: string) {
    const value = raw.trim().replace(/,$/, "").trim();
    if (!value) return;

    const problem = validate?.(value) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    if (!values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      onChange([...values, value]);
    }
    setDraft("");
    setError(null);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}

      <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-border bg-surface p-2">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft
                       px-2.5 py-1 text-sm"
          >
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v !== value))}
              aria-label={`Remove ${value}`}
              className="text-muted transition hover:text-danger"
            >
              &times;
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => commit(draft)}
          placeholder={values.length ? "" : placeholder}
          className="min-w-32 flex-1 bg-transparent px-1 py-1 text-sm outline-none"
        />
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
