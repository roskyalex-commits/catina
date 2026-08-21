import { isDatabaseConfigured } from "@/lib/env";
import { scoreLead } from "@/lib/signals/scoring";
import type { Icp } from "@/lib/icp/schema";
import type { Signal } from "@/lib/signals/types";
import type { SourcedCompany } from "@/lib/sources/types";
import { flamesFor } from "./score";
import type {
  ActivityEvent,
  AgentDetail,
  AgentSummary,
  ChartData,
  ContactRow,
  ContactSignal,
  QueuedMessage,
  SourceLabel,
} from "./types";

/**
 * The demo dataset.
 *
 * Rendered whenever no database is configured, which today is always. Two rules
 * shaped it:
 *
 * 1. **Scores are computed, not written.** Every row runs through the real
 *    `scoreLead`, so the tables exercise the engine and a scoring regression
 *    shows up as a wrong number on screen rather than passing unnoticed.
 * 2. **Everyone here is invented.** Names, domains and CUIs are fabricated;
 *    none are copied from a real account. Evidence URLs point at the public
 *    registry and job-board roots rather than fake deep links, so nothing
 *    resolves to a page that does not exist.
 */

export function isDemoMode(): boolean {
  return !isDatabaseConfigured();
}

/* ------------------------------------------------------------ determinism */

/** mulberry32 — a small, fast, stable PRNG so counts don't jitter per render. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Anchored to the top of the hour.
 *
 * Two constraints pull against each other: the dataset must be stable so a page
 * rendered twice does not shuffle its numbers, and every event must stay in the
 * past so the feed never says an email was sent "in 6 hours". Truncating to the
 * hour satisfies both — the anchor never runs ahead of now, and it only moves
 * once an hour.
 */
function anchor(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  return d;
}

/* ------------------------------------------------------------------- seeds */

const DEMO_ICP: Icp = {
  valueProp:
    "Invoicing and e-Factura automation for Romanian small and mid-sized businesses.",
  productName: "Cătină Facturare",
  targetTitles: [
    "Director General",
    "CEO",
    "Director Financiar",
    "Chief Marketing Officer",
    "Head of Operations",
  ],
  targetSeniorities: ["founder", "c_level", "director"],
  industries: ["E-commerce", "Retail", "Software"],
  industryKeys: ["ecommerce", "retail", "software"],
  caenCodes: ["4791", "6201", "6210", "4649"],
  caenCodesOverridden: false,
  companyTypes: ["smb", "ecommerce"],
  countries: ["RO", "BG", "HU"],
  keywords: ["facturare", "e-factura", "ERP", "contabilitate"],
  competitorTech: ["SmartBill"],
  competitorNames: ["Oblio", "FGO"],
  exclusions: ["staffing", "gambling"],
  employeeMin: 10,
  employeeMax: 250,
  revenueMinRon: 1_000_000,
  revenueMaxRon: 80_000_000,
  confidence: 0.86,
  assumptions: [
    "Pricing page lists RON, so Romania was taken as the primary market.",
    "No headcount stated on the site — the 10-250 band is inferred from the case studies.",
  ],
};

type Seed = {
  person: string;
  title: string;
  company: string;
  domain: string;
  county: string;
  caen: string;
  caenLabel: string;
  employees: number;
  revenue: number;
  prevRevenue: number;
  country: string;
  signal: SourceLabel;
  keyword: string;
  emailStatus: "verified" | "found" | "pattern";
  role: boolean;
  phone: string | null;
};

const SEEDS: Seed[] = [
  { person: "Ana Popescu", title: "Director General", company: "Exemplu Retail SRL", domain: "exemplu-retail.ro", county: "Cluj", caen: "4791", caenLabel: "Comerț cu amănuntul prin internet", employees: 48, revenue: 5_400_000, prevRevenue: 3_800_000, country: "RO", signal: "signal", keyword: "e-factura", emailStatus: "verified", role: false, phone: "+40 264 000 000" },
  { person: "Mihai Ionescu", title: "Director Financiar", company: "Nordic Depozit SA", domain: "nordicdepozit.ro", county: "Iași", caen: "4649", caenLabel: "Comerț cu ridicata al altor bunuri", employees: 132, revenue: 21_900_000, prevRevenue: 18_400_000, country: "RO", signal: "keyword", keyword: "ERP", emailStatus: "verified", role: false, phone: null },
  { person: "Ioana Dumitrescu", title: "Chief Marketing Officer", company: "Verdant Software SRL", domain: "verdant.ro", county: "București", caen: "6201", caenLabel: "Activități de realizare a software-ului", employees: 74, revenue: 12_300_000, prevRevenue: 11_800_000, country: "RO", signal: "lookalike", keyword: "", emailStatus: "found", role: false, phone: "+40 21 000 0000" },
  { person: "Radu Marinescu", title: "Head of Operations", company: "Cargo Trans Vest SRL", domain: "cargotransvest.ro", county: "Timiș", caen: "4941", caenLabel: "Transporturi rutiere de mărfuri", employees: 210, revenue: 34_600_000, prevRevenue: 25_100_000, country: "RO", signal: "signal", keyword: "facturare", emailStatus: "verified", role: false, phone: null },
  { person: "Elena Stoica", title: "Owner", company: "Bio Market Braşov SRL", domain: "biomarketbv.ro", county: "Brașov", caen: "4711", caenLabel: "Comerț cu amănuntul în magazine nespecializate", employees: 22, revenue: 2_700_000, prevRevenue: 2_500_000, country: "RO", signal: "keyword", keyword: "contabilitate", emailStatus: "pattern", role: true, phone: null },
  { person: "Andrei Constantin", title: "CEO", company: "Delta Digital SRL", domain: "deltadigital.ro", county: "Constanța", caen: "6201", caenLabel: "Activități de realizare a software-ului", employees: 36, revenue: 4_100_000, prevRevenue: 2_400_000, country: "RO", signal: "signal", keyword: "e-factura", emailStatus: "verified", role: false, phone: "+40 241 000 000" },
  { person: "Cristina Barbu", title: "Marketing Director", company: "Aurora Cosmetics SRL", domain: "auroracosmetics.ro", county: "Cluj", caen: "4775", caenLabel: "Comerț cu amănuntul al produselor cosmetice", employees: 58, revenue: 8_900_000, prevRevenue: 6_200_000, country: "RO", signal: "lookalike", keyword: "", emailStatus: "found", role: false, phone: null },
  { person: "Bogdan Neagu", title: "Director General", company: "Metalurgica Prod SA", domain: "metalurgicaprod.ro", county: "Dolj", caen: "2511", caenLabel: "Fabricarea de construcții metalice", employees: 340, revenue: 61_000_000, prevRevenue: 58_700_000, country: "RO", signal: "keyword", keyword: "ERP", emailStatus: "pattern", role: true, phone: null },
  { person: "Petar Dimitrov", title: "Managing Director", company: "Sofia Trade Group EOOD", domain: "sofiatradegroup.bg", county: "Sofia", caen: "4649", caenLabel: "Wholesale of other goods", employees: 95, revenue: 14_200_000, prevRevenue: 12_900_000, country: "BG", signal: "keyword", keyword: "invoicing", emailStatus: "found", role: false, phone: null },
  { person: "Katalin Varga", title: "CFO", company: "Duna Logisztika Kft", domain: "dunalogisztika.hu", county: "Budapest", caen: "5210", caenLabel: "Warehousing and storage", employees: 160, revenue: 26_800_000, prevRevenue: 22_100_000, country: "HU", signal: "signal", keyword: "billing automation", emailStatus: "verified", role: false, phone: "+36 1 000 0000" },
  { person: "Simona Vlad", title: "Head of Finance", company: "Carpathian Foods SRL", domain: "carpathianfoods.ro", county: "Sibiu", caen: "1089", caenLabel: "Fabricarea altor produse alimentare", employees: 88, revenue: 16_400_000, prevRevenue: 11_300_000, country: "RO", signal: "signal", keyword: "facturare", emailStatus: "verified", role: false, phone: null },
  { person: "Tudor Apostol", title: "Founder", company: "Nimbus Cloud SRL", domain: "nimbuscloud.ro", county: "București", caen: "6311", caenLabel: "Prelucrarea datelor, administrarea paginilor web", employees: 14, revenue: 1_900_000, prevRevenue: 900_000, country: "RO", signal: "lookalike", keyword: "", emailStatus: "found", role: false, phone: null },
];

const SIGNAL_TEMPLATES: Record<string, (s: Seed) => Signal[]> = {
  growth: (s) => [
    {
      type: "anaf_revenue_growth",
      title: `Revenue up ${Math.round(((s.revenue - s.prevRevenue) / s.prevRevenue) * 100)}% to ${(s.revenue / 1_000_000).toFixed(1)}M RON`,
      evidenceUrl: "https://mfinante.gov.ro/domenii/informatii-contribuabili",
      strength: 0.62,
      detectedAt: new Date(),
      dedupeKey: `${s.domain}:growth`,
    },
  ],
  hiring: (s) => [
    {
      type: "hiring_buyer_role",
      title: `Hiring a ${s.title} — your buyer, arriving soon`,
      evidenceUrl: `https://${s.domain}/cariere`,
      strength: 0.94,
      detectedAt: new Date(),
      dedupeKey: `${s.domain}:hiring`,
    },
  ],
  vat: (s) => [
    {
      type: "vat_registered",
      title: "Newly VAT-registered — scaling past the threshold",
      evidenceUrl: "https://webservicesp.anaf.ro",
      strength: 0.55,
      detectedAt: new Date(),
      dedupeKey: `${s.domain}:vat`,
    },
  ],
};

/* ------------------------------------------------------------- construction */

function toCompany(s: Seed): SourcedCompany {
  return {
    dedupeKey: s.domain,
    name: s.company,
    domain: s.domain,
    country: s.country,
    county: s.county,
    caen: s.caen,
    caenLabel: s.caenLabel,
    cui: String(10_000_000 + (s.domain.length * 733_211) % 89_999_999),
    employeesAnaf: s.employees,
    employeeCount: s.employees,
    revenueRon: s.revenue,
    revenuePrevRon: s.prevRevenue,
    vatRegistered: true,
    insolvencyStatus: null,
    source: "anaf",
  };
}

function emailFor(s: Seed): ContactRow["email"] {
  const [first = "", last = ""] = s.person.toLowerCase().split(" ");
  const local = s.role ? "contact" : `${strip(first)}.${strip(last)}`;
  const confidence =
    s.emailStatus === "verified" ? 0.94 : s.emailStatus === "found" ? 0.71 : 0.42;
  return {
    address: `${local}@${s.domain}`,
    status: s.emailStatus,
    confidence,
    isRoleAddress: s.role,
  };
}

/** Romanian diacritics do not belong in an email local part. */
function strip(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
}

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

function signalFor(s: Seed, signals: Signal[]): ContactSignal | null {
  if (s.signal === "lookalike") {
    return { title: "Lookalike match: similar to your ideal lead", kind: "lookalike" };
  }
  const first = signals[0];
  if (!first) return null;
  return {
    title: first.title,
    evidenceUrl: first.evidenceUrl,
    query: s.keyword || undefined,
    kind: s.signal,
  };
}

export type DemoDataset = {
  contacts: ContactRow[];
  agents: AgentDetail[];
  activeSignals: number;
};

let cached: { key: string; value: DemoDataset } | null = null;

export function demoDataset(now: Date = new Date()): DemoDataset {
  const base = anchor(now);
  const key = base.toISOString();
  if (cached?.key === key) return cached.value;

  const random = rng(20260818);
  const contacts: ContactRow[] = [];

  SEEDS.forEach((seed, i) => {
    const company = toCompany(seed);
    const grew = seed.revenue > seed.prevRevenue * 1.15;
    const templates = [
      ...(grew ? SIGNAL_TEMPLATES.growth(seed) : []),
      ...(i % 3 === 0 ? SIGNAL_TEMPLATES.hiring(seed) : []),
      ...(i % 5 === 0 ? SIGNAL_TEMPLATES.vat(seed) : []),
    ];
    // Spread detection over the last three weeks, deterministically.
    const signals = templates.map((signal, n) => ({
      ...signal,
      detectedAt: new Date(base.getTime() - (2 + n * 4 + (i % 7)) * DAY),
    }));

    const email = emailFor(seed);
    const breakdown = scoreLead({
      icp: DEMO_ICP,
      company,
      person: { fullName: seed.person, title: seed.title },
      signals: seed.signal === "lookalike" ? [] : signals,
      email: {
        status: email!.status,
        confidence: email!.confidence,
        isRoleAddress: email!.isRoleAddress,
      },
      now: base,
    });

    contacts.push({
      id: `demo-lead-${i + 1}`,
      fullName: seed.person,
      title: seed.title,
      companyName: seed.company,
      companyDomain: seed.domain,
      country: seed.country,
      county: seed.county,
      caen: seed.caen,
      signal: signalFor(seed, signals),
      score: breakdown.total,
      flames: flamesFor(breakdown.total),
      breakdown,
      email,
      phone: seed.phone,
      address: `Str. Exemplu ${i + 1}, ${seed.county}`,
      importedAt: new Date(base.getTime() - HOUR - i * 47 * 60_000),
      list:
        seed.country === "RO"
          ? { id: "list-ro", name: "Romania · SMB" }
          : { id: "list-eu", name: "CEE expansion" },
      fitFeedback: i === 0 ? "good" : i === 4 ? "bad" : null,
      agentId: i % 3 === 2 ? "agent-cee" : "agent-ro",
    });
  });

  contacts.sort((a, b) => b.score - a.score);

  const agents = [
    buildAgent({
      id: "agent-ro",
      name: "Romania · Finance & Ops",
      status: "active",
      base,
      random,
      contacts: contacts.filter((c) => c.agentId === "agent-ro"),
      countries: ["RO"],
      keywords: ["facturare", "e-factura", "ERP", "contabilitate"],
      caenCodes: ["4791", "6201", "4649"],
      mailbox: { address: "sales@catina.ro", warmingUp: true },
    }),
    buildAgent({
      id: "agent-cee",
      name: "CEE expansion",
      status: "paused",
      base,
      random,
      contacts: contacts.filter((c) => c.agentId === "agent-cee"),
      countries: ["BG", "HU"],
      keywords: ["invoicing", "billing automation"],
      caenCodes: ["4649", "5210"],
      mailbox: null,
    }),
  ];

  const activeSignals = contacts.filter(
    (c) => c.signal && c.signal.kind !== "lookalike",
  ).length;

  const value: DemoDataset = { contacts, agents, activeSignals };
  cached = { key, value };
  return value;
}

function buildAgent(input: {
  id: string;
  name: string;
  status: AgentSummary["status"];
  base: Date;
  random: () => number;
  contacts: ContactRow[];
  countries: string[];
  keywords: string[];
  caenCodes: string[];
  mailbox: { address: string; warmingUp: boolean } | null;
}): AgentDetail {
  const { base, contacts, random } = input;
  const found = contacts.length;
  const contacted = Math.max(0, Math.round(found * 0.55));
  const emailsSent = Math.round(contacted * 1.4);

  const days = 7;
  const labels: string[] = [];
  const leadPoints: number[] = [];
  const companyPoints: number[] = [];
  const signalPoints: number[] = [];
  const emailPoints: number[] = [];

  const midnight = new Date(base);
  midnight.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(midnight.getTime() - i * DAY);
    labels.push(
      day.toLocaleDateString("en-GB", { month: "short", day: "numeric" }),
    );
    const scale = input.status === "active" ? 1 : 0.35;
    leadPoints.push(Math.round(random() * 22 * scale));
    companyPoints.push(Math.round(random() * 40 * scale));
    signalPoints.push(Math.round(random() * 6 * scale));
    emailPoints.push(Math.round(random() * 9 * scale));
  }

  const chart: ChartData = {
    labels,
    series: [
      { key: "leads", label: "Leads found", color: "--series-leads", points: leadPoints },
      { key: "companies", label: "Companies sourced", color: "--series-invites", points: companyPoints },
      { key: "signals", label: "Signals detected", color: "--series-messages", points: signalPoints },
      { key: "emails", label: "Emails sent", color: "--series-emails", points: emailPoints },
    ],
  };

  const verifiable = contacts.filter(
    (c) => c.email && (c.email.status === "verified" || c.email.status === "found"),
  ).length;

  return {
    id: input.id,
    name: input.name,
    status: input.status,
    createdAt: new Date(base.getTime() - 5 * DAY),
    nextLaunchAt:
      input.status === "active" ? new Date(base.getTime() + 32 * HOUR) : null,
    mailbox: input.mailbox,
    leadsFound: found,
    contacted,
    countries: input.countries,
    stats: { found, contacted, replied: 0, interested: 0 },
    sendStats: {
      emailsSent,
      bounces: 0,
      unsubscribes: input.status === "active" ? 1 : 0,
      deliverablePct: found ? Math.round((verifiable / found) * 1000) / 10 : null,
    },
    chart,
    activity: buildActivity(input.id, base, contacts, input.keywords),
    queue: buildQueue(base, contacts),
    leads: contacts,
    sources: {
      keywords: input.keywords,
      industries: DEMO_ICP.industries,
      industryKeys: DEMO_ICP.industryKeys,
      caenCodes: input.caenCodes,
      countries: input.countries,
      targetTitles: DEMO_ICP.targetTitles,
      competitorTech: DEMO_ICP.competitorTech,
      competitorNames: DEMO_ICP.competitorNames,
      // Keys from SIGNAL_SOURCE_CATALOGUE, not SignalType values — the Sources
      // tab lists catalogue entries, and the two vocabularies differ.
      enabledSignals: [
        "keyword_site",
        "competitor_tech",
        "anaf_growth",
        "anaf_status",
        "hiring",
        "tech_stack",
      ],
    },
    campaign: {
      autoSend: false,
      dailySendLimit: 20,
      senderEmail: input.mailbox?.address ?? null,
      complianceAcknowledged: input.status === "active",
      steps: [
        { stepIndex: 0, delayDays: 0, instruction: "Open with the signal. One question, no pitch." },
        { stepIndex: 1, delayDays: 4, instruction: "Short nudge referencing the same filing." },
      ],
    },
    pendingReview:
      input.status === "active" && contacts.length
        ? { count: Math.min(contacts.length, 6) }
        : null,
  };
}

function buildActivity(
  agentId: string,
  base: Date,
  contacts: ContactRow[],
  keywords: string[],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let n = 0;
  const push = (e: Omit<ActivityEvent, "id">) =>
    events.push({ ...e, id: `${agentId}-act-${(n += 1)}` });

  contacts.slice(0, 5).forEach((contact, i) => {
    push({
      title: "Email sent",
      subtitle: `${contact.fullName} · ${contact.companyName}`,
      kind: "email_sent",
      at: new Date(base.getTime() - HOUR - i * 40 * 60_000),
      initials: initials(contact.fullName),
    });
  });

  push({
    title: `${contacts.length} new leads found`,
    subtitle: keywords[0] ? `Keyword: "${keywords[0]}"` : null,
    kind: "leads_found",
    at: new Date(base.getTime() - 5 * HOUR),
  });

  keywords.slice(1, 3).forEach((keyword, i) => {
    push({
      title: "No new leads found",
      subtitle: `Keyword: "${keyword}"`,
      kind: "no_leads",
      at: new Date(base.getTime() - (10 + i * 7) * HOUR),
    });
  });

  contacts
    .filter((c) => c.signal && c.signal.kind === "signal")
    .slice(0, 3)
    .forEach((contact, i) => {
      push({
        title: contact.signal!.title,
        subtitle: contact.companyName,
        kind: "signal",
        at: new Date(base.getTime() - (26 + i * 9) * HOUR),
      });
    });

  return events.sort((a, b) => b.at.getTime() - a.at.getTime());
}

function buildQueue(base: Date, contacts: ContactRow[]): QueuedMessage[] {
  return contacts
    .filter((c) => c.email && c.score >= 40)
    .slice(0, 6)
    .map((contact, i) => ({
      id: `queue-${contact.id}`,
      contactName: contact.fullName,
      companyName: contact.companyName,
      subject:
        contact.signal?.kind === "lookalike"
          ? `${contact.companyName} — a quick question`
          : `Re: ${contact.signal?.title ?? "your growth this year"}`,
      preview:
        "Saw the filing come through and thought of you — most teams at that " +
        "size hit the e-Factura deadline with a spreadsheet in the middle.",
      reason: contact.signal?.title ?? "ICP fit",
      scheduledFor: new Date(base.getTime() + (9 + i * 2) * HOUR),
      complianceWarning:
        contact.country === "RO"
          ? "Romania requires prior consent (Law 506/2004) — no B2B exemption."
          : null,
    }));
}

export { DEMO_ICP };
