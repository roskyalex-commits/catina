import { z } from "zod";

/**
 * The structured ICP that onboarding step 1 produces and step 2 lets the user
 * correct. Shared by the Claude tool definition, the API route and the form, so
 * all three cannot drift apart.
 */

export const SENIORITIES = [
  "founder",
  "c_level",
  "vp",
  "director",
  "head",
  "manager",
  "individual_contributor",
] as const;

export const COMPANY_TYPES = [
  "startup",
  "smb",
  "mid_market",
  "enterprise",
  "agency",
  "ecommerce",
  "nonprofit",
  "public_sector",
] as const;

export const icpSchema = z.object({
  /** One sentence, in the seller's own words, on what they sell and to whom. */
  valueProp: z.string().min(10).max(400),
  /** Short label for the offering, used in outreach copy. */
  productName: z.string().max(120).optional(),

  targetTitles: z.array(z.string().min(2).max(80)).min(1).max(15),
  targetSeniorities: z.array(z.enum(SENIORITIES)).max(7).default([]),
  /**
   * Free-text industries, in the seller's own words.
   *
   * Kept rather than replaced by `industryKeys`: it is the only thing a market
   * outside Romania has, and it is what the user actually typed. `industryKeys`
   * is the load-bearing field; this one survives so nothing the user wrote is
   * silently discarded when it fails to resolve.
   */
  industries: z.array(z.string().min(2).max(80)).max(15).default([]),
  /**
   * Resolved industry keys — the load-bearing targeting field.
   *
   * Validated against the catalogue in `industry-definitions.ts` at the
   * normalisation boundary rather than here, so an unrecognised industry
   * degrades to an entry in `unresolved` instead of failing the whole ICP.
   */
  industryKeys: z.array(z.string().min(2).max(60)).max(37).default([]),
  /**
   * Romanian CAEN activity codes. 4 digits, e.g. "6210" (custom software).
   * This is the targeting axis no international competitor offers, and it is
   * still what the sourcing query filters on.
   *
   * Derived from `industryKeys` by `normaliseIcpIndustries` unless
   * `caenCodesOverridden` is set. The ceiling is 60 rather than 20 because one
   * industry can span both CAEN revisions and several divisions — "wholesale"
   * alone expands to 57 classes.
   */
  caenCodes: z.array(z.string().regex(/^\d{4}$/)).max(60).default([]),
  /**
   * The user took the code list over by hand.
   *
   * Once true, nothing derives `caenCodes` again. Without this flag the first
   * normalisation pass after an edit would silently overwrite a list somebody
   * deliberately narrowed.
   */
  caenCodesOverridden: z.boolean().default(false),
  companyTypes: z.array(z.enum(COMPANY_TYPES)).max(8).default([]),
  /** ISO 3166-1 alpha-2. */
  countries: z.array(z.string().length(2)).max(30).default(["RO"]),
  keywords: z.array(z.string().min(2).max(60)).max(20).default([]),
  /**
   * Competing products we can fingerprint on a prospect's site.
   *
   * Constrained to `DETECTABLE_TECH` at the normalisation boundary rather than
   * here, so a name we cannot detect degrades into `competitorNames` instead of
   * failing the whole ICP. Promising to spot a competitor and then silently not
   * spotting it is worse than saying the detection is weaker.
   */
  competitorTech: z.array(z.string().min(2).max(60)).max(15).default([]),
  /** Competitor brands with no detectable marker — matched as text. */
  competitorNames: z.array(z.string().min(2).max(80)).max(15).default([]),
  /** Segments to keep out: competitors, bad-fit verticals, existing customers. */
  exclusions: z.array(z.string().min(2).max(80)).max(20).default([]),

  employeeMin: z.number().int().min(0).max(1_000_000).nullable().default(null),
  employeeMax: z.number().int().min(0).max(1_000_000).nullable().default(null),

  /**
   * Revenue band in RON, from ANAF's annual filings. Not inferred from the
   * website — the model has no basis for it — so these stay null until the
   * user sets them in onboarding step 2. Romania-only: no other market in the
   * MVP has free, official revenue data to filter on.
   */
  revenueMinRon: z.number().min(0).nullable().default(null),
  revenueMaxRon: z.number().min(0).nullable().default(null),

  /** 0..1 — how well the site supported this inference. Drives UI nudges. */
  confidence: z.number().min(0).max(1).default(0.5),
  /** What was guessed rather than read, so the user knows what to check. */
  assumptions: z.array(z.string().max(200)).max(6).default([]),
});

export type Icp = z.infer<typeof icpSchema>;
export type Seniority = (typeof SENIORITIES)[number];
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const SENIORITY_LABELS: Record<(typeof SENIORITIES)[number], string> = {
  founder: "Founder / Owner",
  c_level: "C-level (CEO, CMO, CTO…)",
  vp: "VP",
  director: "Director",
  head: "Head of",
  manager: "Manager",
  individual_contributor: "Individual contributor",
};

export const COMPANY_TYPE_LABELS: Record<
  (typeof COMPANY_TYPES)[number],
  string
> = {
  startup: "Startup",
  smb: "Small business",
  mid_market: "Mid-market",
  enterprise: "Enterprise",
  agency: "Agency",
  ecommerce: "E-commerce",
  nonprofit: "Non-profit",
  public_sector: "Public sector",
};
