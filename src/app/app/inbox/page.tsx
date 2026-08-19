import { Inbox, ShieldAlert } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";

/**
 * Inbox.
 *
 * A real screen with nothing in it, and the explanation is the content. Reading
 * a Gmail mailbox needs `gmail.readonly` or `gmail.modify`, both of which
 * Google classifies as *restricted* — that means an annual CASA Tier 2 security
 * assessment (roughly $540-1,000/yr) on top of app verification. Sending needs
 * only `gmail.send` and `gmail.compose`, which are merely *sensitive*.
 *
 * So outreach works today and reply tracking does not. Saying that plainly is
 * better than a screen that looks broken or, worse, a fabricated count.
 */
export default function InboxPage() {
  return (
    <>
      <PageHeader
        icon={Inbox}
        title="Inbox"
        description="Replies to your outreach, in one thread per lead."
      />

      <EmptyState icon={Inbox} title="Reply tracking is not connected">
        Replies land in your own Gmail inbox as normal. They are not mirrored
        here yet.
      </EmptyState>

      <Card className="mt-5 max-w-2xl p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-warning-soft text-warning">
            <ShieldAlert className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div>
            <h2 className="text-[15px] font-semibold">Why this is empty</h2>
            <p className="mt-1 text-[13px] text-muted">
              Sending mail and reading mail sit in different Google scope tiers.
            </p>

            <dl className="mt-4 space-y-3 text-[13px]">
              <div>
                <dt className="font-medium">
                  Sending · <span className="text-success">sensitive scope</span>
                </dt>
                <dd className="text-muted">
                  <code className="font-mono">gmail.send</code> and{" "}
                  <code className="font-mono">gmail.compose</code>. App
                  verification only — about ten days, no fee. This is what
                  outreach uses, and it works.
                </dd>
              </div>
              <div>
                <dt className="font-medium">
                  Reading · <span className="text-danger">restricted scope</span>
                </dt>
                <dd className="text-muted">
                  <code className="font-mono">gmail.readonly</code> or{" "}
                  <code className="font-mono">gmail.modify</code>. Requires an
                  annual CASA Tier 2 security assessment, roughly $540-1,000 a
                  year, recertified every year.
                </dd>
              </div>
            </dl>

            <p className="mt-4 text-[13px] text-muted">
              Until that assessment is worth paying for, reply rate, open
              conversations and &ldquo;interested&rdquo; counts stay at zero
              rather than being estimated. Deliverability — the share of
              addresses that are verified — is reported instead, because it is
              measured rather than inferred.
            </p>
          </div>
        </div>
      </Card>
    </>
  );
}
