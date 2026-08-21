"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Clock, Loader2 } from "lucide-react";
import { Button, Card, relativeTime } from "@/components/ui/primitives";
import type { QueuedMessage } from "@/lib/data/types";

/**
 * The send queue, with buttons that do something.
 *
 * The three actions are not variations on one control, and the copy says so:
 *
 * - **Approve** hands the message to the scheduler. It goes out at its
 *   scheduled time, spread across working hours with jitter.
 * - **Send now** goes immediately, through the same guard the scheduler uses.
 * - **Skip** retires it. The lead is not written to.
 *
 * There is deliberately no "approve all and send". Approving fifty messages
 * at once is a reasonable thing to want; sending fifty in one keystroke is how
 * a mailbox gets flagged, and the daily cap would refuse most of them anyway.
 */
export function QueueList({ messages }: { messages: QueuedMessage[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  async function act(ids: string[], action: "approve" | "skip" | "send") {
    setError(null);
    setBusy(ids.length === 1 ? ids[0] : "all");

    try {
      const response = await fetch("/api/v1/outreach/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageIds: ids, action }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        results?: { id: string; state: string; reason?: string }[];
      };

      if (!response.ok) {
        setError(payload.error ?? "That didn't work. Try again in a moment.");
        return;
      }

      /*
       * A 200 does not mean every message went. `sendOne` returns `skipped` for
       * a recipient who unsubscribed since drafting and `deferred` when the
       * daily cap is reached — both are successful outcomes of the request and
       * failures of the user's intent, so they are shown per message rather
       * than collapsed into a toast.
       */
      const marks: Record<string, string> = {};
      for (const result of payload.results ?? []) {
        marks[result.id] = result.reason ? `${result.state} — ${result.reason}` : result.state;
      }
      for (const id of ids) marks[id] ??= action === "approve" ? "approved" : action;
      setDone((previous) => ({ ...previous, ...marks }));

      // Refresh rather than mutate local state: the queue is derived from
      // message state, and re-deriving it is cheaper than keeping a copy honest.
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  const waiting = messages.filter((message) => !done[message.id]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {waiting.length} message{waiting.length === 1 ? "" : "s"} waiting for your
          approval
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => act(waiting.map((m) => m.id), "skip")}
            disabled={busy !== null || waiting.length === 0}
          >
            Skip all
          </Button>
          <Button
            variant="primary"
            onClick={() => act(waiting.map((m) => m.id), "approve")}
            disabled={busy !== null || waiting.length === 0}
          >
            {busy === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Approve all
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-3 flex items-start gap-2 rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      <ul className="grid gap-3">
        {messages.map((message) => {
          const outcome = done[message.id];
          return (
            <li key={message.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">
                      {message.contactName}{" "}
                      <span className="font-normal text-muted">
                        · {message.companyName}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[13px] text-muted">
                      Why now: {message.reason}
                    </p>
                  </div>
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <Clock className="h-3.5 w-3.5" aria-hidden />
                    Scheduled {relativeTime(message.scheduledFor)}
                  </span>
                </div>

                <div className="mt-3 rounded-[var(--radius-control)] border border-border bg-background p-3">
                  <p className="text-[13px] font-medium">{message.subject}</p>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] text-muted">
                    {message.preview}
                  </p>
                </div>

                {message.complianceWarning && (
                  <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-control)] bg-warning-soft px-3 py-2 text-[13px] text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {message.complianceWarning}
                  </p>
                )}

                {outcome ? (
                  <p className="mt-3 text-[13px] text-muted">{outcome}</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      onClick={() => act([message.id], "send")}
                      disabled={busy !== null || pending}
                    >
                      {busy === message.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : null}
                      Send now
                    </Button>
                    <Button
                      onClick={() => act([message.id], "approve")}
                      disabled={busy !== null || pending}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => act([message.id], "skip")}
                      disabled={busy !== null || pending}
                    >
                      Skip
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </>
  );
}
