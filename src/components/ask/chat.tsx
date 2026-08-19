"use client";

import { useRef, useState } from "react";
import { ArrowRight, Sparkles, Wrench } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Turn = {
  role: "user" | "assistant";
  content: string;
  tools?: { name: string; input: unknown }[];
};

const SUGGESTIONS = [
  "Which leads are worth contacting today, and why?",
  "Which keyword is finding the most leads this week?",
  "Show me Cluj companies whose revenue grew and who are hiring.",
  "Which of my agents is idle, and what would fix it?",
];

/**
 * Ask.
 *
 * Every answer carries the tools it ran. That is not debug output left in by
 * accident — it is the difference between an answer the user can check and one
 * they have to take on faith, and this product's whole argument is that a
 * number you cannot interrogate is a number you will not trust.
 */
export function AskChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function send(question: string) {
    const text = question.trim();
    if (!text || pending) return;

    const next: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(next);
    setInput("");
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/v1/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: next.map(({ role, content }) => ({ role, content })),
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Something went wrong.");
        return;
      }

      setTurns([
        ...next,
        { role: "assistant", content: payload.answer, tools: payload.toolsUsed },
      ]);
      requestAnimationFrame(() =>
        endRef.current?.scrollIntoView({ behavior: "smooth" }),
      );
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      {turns.length === 0 ? (
        <Card className="p-6">
          <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-accent-soft text-accent">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
          <h2 className="mt-3 text-[15px] font-semibold">
            Ask anything about your pipeline
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            Answers come from your sourced leads and launch history. If there is
            nothing to answer from, it will say so rather than improvise.
          </p>

          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  onClick={() => send(suggestion)}
                  className="w-full rounded-[var(--radius-control)] border border-border px-3 py-2.5 text-left text-[13px] text-muted transition hover:border-accent-ring hover:text-foreground"
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <ul className="mb-4 space-y-4">
          {turns.map((turn, i) => (
            <li
              key={i}
              className={cn(
                "flex",
                turn.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-[var(--radius-card)] px-4 py-3 text-[13px]",
                  turn.role === "user"
                    ? "bg-accent text-accent-foreground"
                    : "border border-border bg-surface",
                )}
              >
                <p className="whitespace-pre-wrap">{turn.content}</p>

                {turn.tools && turn.tools.length > 0 && (
                  <details className="mt-3 border-t border-border pt-2">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                      <Wrench className="h-3 w-3" aria-hidden />
                      Checked {turn.tools.length}{" "}
                      {turn.tools.length === 1 ? "source" : "sources"}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {turn.tools.map((tool, n) => (
                        <li key={n} className="font-mono text-[11px] text-muted">
                          {tool.name}({JSON.stringify(tool.input)})
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </li>
          ))}
          <div ref={endRef} />
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
        className="sticky bottom-4 mt-4 flex gap-2"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={pending}
          placeholder={pending ? "Thinking…" : "Ask about your leads…"}
          aria-label="Your question"
          className="flex-1 rounded-[var(--radius-control)] border border-border bg-surface px-4 py-2.5 text-[13px] outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent-ring/50 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          aria-label="Send"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent text-accent-foreground transition hover:bg-accent-hover disabled:opacity-50"
        >
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </form>
    </div>
  );
}
