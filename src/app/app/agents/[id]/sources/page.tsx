import { notFound } from "next/navigation";
import { Building2, Globe, Lock, Radar, Swords, Target } from "lucide-react";
import { industryByKey, naceLabel } from "@/lib/icp/industries";
import { Card, Pill, SectionTitle } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";
import { DEFAULT_ENABLED_SIGNALS } from "@/lib/agents/schema";
import { SIGNAL_SOURCE_CATALOGUE } from "@/lib/signals/scanner";

/**
 * What the agent looks for and where it looks.
 *
 * The signal catalogue is split Romanian / universal because that split is the
 * product's whole argument: ANAF and ONRC are official, free and structurally
 * unavailable to international tools, and no amount of scraping substitutes for
 * a filed balance sheet.
 */
export default async function AgentSourcesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  /*
   * An empty `enabled_signals` means "run the default set", not "run nothing".
   *
   * `selectSignalSources` has always read an empty list as *every* source, and
   * `scan-signals.ts` narrows that to `DEFAULT_ENABLED_SIGNALS`. This page did
   * neither — it rendered the raw column, so an agent that had never been
   * through the picker showed every signal as "Off" while the scanner was
   * happily running them. Telling a user the opposite of what the system does
   * is worse than telling them nothing.
   *
   * The banner below says which case they are in, because "on by default" and
   * "on because you chose it" are different facts.
   */
  const chosen = agent.sources.enabledSignals;
  const usingDefaults = chosen.length === 0;
  const enabled = new Set(usingDefaults ? DEFAULT_ENABLED_SIGNALS : chosen);
  const romanian = SIGNAL_SOURCE_CATALOGUE.filter((s) => s.romaniaOnly);
  const universal = SIGNAL_SOURCE_CATALOGUE.filter((s) => !s.romaniaOnly);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="h-fit p-5">
        <SectionTitle
          title="Targeting"
          description="Who this agent goes looking for."
        />
        <dl className="mt-4 space-y-4">
          <ChipRow icon={Globe} label="Countries" values={agent.sources.countries} />
          <ChipRow
            icon={Building2}
            label="Industries"
            values={agent.sources.industryKeys.map(
              (key) => industryByKey(key)?.label ?? key,
            )}
          />
          <ChipRow icon={Target} label="Job titles" values={agent.sources.targetTitles} />
          <ChipRow icon={Radar} label="Keywords" values={agent.sources.keywords} />
          <ChipRow
            icon={Swords}
            label="Competitors we can fingerprint"
            values={agent.sources.competitorTech}
          />
          <ChipRow
            icon={Swords}
            label="Competitors matched as text"
            values={agent.sources.competitorNames}
          />
          {/*
            Collapsed, because CAEN codes are now derived from the industries
            above rather than chosen. They stay visible because they are what
            the query actually filters on, and a user debugging an empty result
            needs to see them — but they are no longer the thing to read first.
          */}
          <details className="group">
            <summary className="cursor-pointer list-none text-[13px] text-muted hover:text-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5" />
                {agent.sources.caenCodes.length} CAEN codes, derived from those industries
              </span>
            </summary>
            <dd className="mt-2 space-y-1">
              {agent.sources.caenCodes.length === 0 ? (
                <p className="text-[13px] text-muted">
                  None — sourcing will match on size and location alone.
                </p>
              ) : (
                agent.sources.caenCodes.map((code) => (
                  <p key={code} className="text-[12px] text-muted">
                    <span className="font-mono text-foreground">{code}</span>{" "}
                    {naceLabel(code) ?? ""}
                  </p>
                ))
              )}
            </dd>
          </details>
        </dl>
      </Card>

      <div className="space-y-5">
        {usingDefaults && (
          <Card className="p-4">
            <p className="text-[13px]">
              <span className="font-medium">Running the default signals.</span>{" "}
              This agent has never been through the signal picker, so it watches
              the free sources that fire without a previous scan. Re-run
              onboarding to choose for yourself.
            </p>
          </Card>
        )}

        <Card className="p-5">
          <SectionTitle
            title="Romanian registry"
            description="Official, free, and unavailable to international tools."
          />
          <SourceList sources={romanian} enabled={enabled} />
        </Card>

        <Card className="p-5">
          <SectionTitle
            title="Universal sources"
            description="Work in any market the agent targets."
          />
          <SourceList sources={universal} enabled={enabled} />
        </Card>
      </div>
    </div>
  );
}

function ChipRow({
  icon: Icon,
  label,
  values,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  values: string[];
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-[13px] text-muted">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd className="mt-1.5 flex flex-wrap gap-1.5">
        {values.length === 0 ? (
          <span className="text-[13px] text-muted">Not set</span>
        ) : (
          values.map((value) => (
            <span
              key={value}
              className={`rounded-full bg-background px-2.5 py-1 text-[12px] ${mono ? "font-mono" : ""}`}
            >
              {value}
            </span>
          ))
        )}
      </dd>
    </div>
  );
}

function SourceList({
  sources,
  enabled,
}: {
  sources: typeof SIGNAL_SOURCE_CATALOGUE;
  enabled: Set<string>;
}) {
  return (
    <ul className="mt-4 divide-y divide-border">
      {sources.map((source) => (
        <li key={source.key} className="py-3">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
            {source.label}
            {!source.available ? (
              <Pill tone="neutral">
                <Lock className="h-3 w-3" />
                Not connected
              </Pill>
            ) : enabled.has(source.key) ? (
              <Pill tone="success" dot>
                On
              </Pill>
            ) : (
              <Pill tone="neutral">Off</Pill>
            )}
            {source.needsPreviousScan ? (
              <Pill tone="neutral">Needs a second scan</Pill>
            ) : null}
          </p>
          <p className="mt-0.5 text-[13px] text-muted">{source.description}</p>
          {/*
            An unavailable source states why rather than being hidden. Two of
            the categories the competitor leads on have no free equivalent, and
            a user comparing the two products deserves to read that here.
          */}
          {source.unavailableReason ? (
            <p className="mt-1 text-[12px] text-muted">{source.unavailableReason}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
