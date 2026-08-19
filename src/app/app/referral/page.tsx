import { Gift } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";

export default function ReferralPage() {
  return (
    <>
      <PageHeader
        icon={Gift}
        title="Join Referral program"
        description="Invite another team and you both get enrichment credits."
      />
      <Card className="max-w-2xl p-5">
        <EmptyState icon={Gift} title="Not open yet" compact>
          The referral programme opens once billing does. Credits are the only
          metered resource here — registry sourcing costs nothing, so that is
          what a referral will be worth.
        </EmptyState>
      </Card>
    </>
  );
}
