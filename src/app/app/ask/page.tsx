import { Sparkles } from "lucide-react";
import { AskChat } from "@/components/ask/chat";
import { PageHeader, Pill } from "@/components/ui/primitives";

export default function AskPage() {
  return (
    <>
      <PageHeader
        icon={Sparkles}
        title="Ask"
        description="Questions about your own leads, agents and launches — answered from your data, not from a guess."
        action={<Pill tone="warning">Beta</Pill>}
      />
      <AskChat />
    </>
  );
}
