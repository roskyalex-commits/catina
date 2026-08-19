import { CircleHelp } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/primitives";

const TOPICS = [
  {
    title: "How an agent finds leads",
    body: "It matches your ideal customer against the Romanian trade register by CAEN activity code, county, headcount and filed revenue, then resolves decision-makers at the companies that match.",
  },
  {
    title: "Why some leads have no email",
    body: "The waterfall checks MX records first, then role addresses, then pattern inference, then any configured provider. A pattern-derived address is never labelled verified — guesses are offered as alternatives, not answers.",
  },
  {
    title: "Why a message is waiting for approval",
    body: "Auto-send is off on the Free plan and off by default on every plan. An unattended sender on an unverified account is how a domain reputation gets burned.",
  },
  {
    title: "Why Romania warns before sending",
    body: "Law 506/2004 requires express prior consent for commercial email and has no B2B exemption, unlike the UK or the Netherlands. The app warns and records an acknowledgement; the decision stays yours.",
  },
];

export default function HelpPage() {
  return (
    <>
      <PageHeader
        icon={CircleHelp}
        title="Help Center"
        description="How the parts fit together."
      />
      <div className="grid max-w-3xl gap-3">
        {TOPICS.map((topic) => (
          <Card key={topic.title} className="p-5">
            <h2 className="text-[15px] font-semibold">{topic.title}</h2>
            <p className="mt-1.5 text-[13px] text-muted">{topic.body}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
