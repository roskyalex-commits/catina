import * as cheerio from "cheerio";

/**
 * Minimal, polite site reader used by onboarding (and later reused by the
 * signal sources for pricing-page diffs and team-page extraction).
 *
 * Scope is deliberately tiny: a handful of known pages, one hop, no recursion.
 * This is not a crawler framework — plan §6 defers that until the Phase 2b
 * free-API spike proves it is actually needed.
 */

const USER_AGENT =
  "CatinaBot/0.1 (+https://catina.ro/bot; B2B lead research; contact@catina.ro)";

/** Pages that most reliably carry positioning and customer signals. */
const CANDIDATE_PATHS = [
  "/",
  "/about",
  "/about-us",
  "/despre-noi",
  "/pricing",
  "/preturi",
  "/products",
  "/solutions",
  "/customers",
  "/clienti",
];

const MAX_PAGES = 5;
const MAX_BYTES_PER_PAGE = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Claude gets plenty of signal from this much text; more just costs tokens. */
const MAX_TEXT_PER_PAGE = 6_000;

export type FetchedPage = {
  url: string;
  title: string;
  text: string;
};

export type SiteSnapshot = {
  domain: string;
  origin: string;
  pages: FetchedPage[];
  /** Detected without BuiltWith/Wappalyzer — see `fingerprintTech`. */
  techStack: string[];
  /** Public role addresses found in markup; the RO-defensible contact route. */
  roleEmails: string[];
  socialLinks: { linkedin?: string; twitter?: string; facebook?: string };
};

export class SiteFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_url"
      | "unreachable"
      | "blocked_by_robots"
      | "empty",
  ) {
    super(message);
    this.name = "SiteFetchError";
  }
}

export function normaliseUrl(input: string): URL {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new SiteFetchError(`"${input}" is not a valid URL`, "invalid_url");
  }

  if (!url.hostname.includes(".")) {
    throw new SiteFetchError(`"${input}" is not a valid domain`, "invalid_url");
  }
  return url;
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Honours Disallow rules that apply to us. Best-effort by design: a missing or
 * malformed robots.txt means "allowed", which matches how the standard is
 * conventionally read.
 */
async function loadRobotsRules(origin: string): Promise<string[]> {
  const res = await fetchWithTimeout(`${origin}/robots.txt`);
  if (!res?.ok) return [];

  const body = (await res.text()).slice(0, 100_000);
  const disallows: string[] = [];
  let appliesToUs = false;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      const agent = value.toLowerCase();
      appliesToUs = agent === "*" || agent.includes("catinabot");
    } else if (key === "disallow" && appliesToUs && value) {
      disallows.push(value);
    }
  }
  return disallows;
}

function isAllowed(path: string, disallows: string[]): boolean {
  return !disallows.some((rule) => rule !== "/" && path.startsWith(rule));
}

/**
 * Technology fingerprints, by product name.
 *
 * Hoisted out of `fingerprintTech` so the product names can also be offered as
 * a vocabulary: a user naming a competitor needs to know which ones we can
 * actually detect, and "we found HubSpot on their site" is only honest if
 * HubSpot is in this table.
 */
export const TECH_MARKERS: Record<string, RegExp> = {
  Shopify: /cdn\.shopify\.com|shopify-section/,
  WooCommerce: /woocommerce/,
  Magento: /mage-init|magento/,
  PrestaShop: /prestashop/,
  WordPress: /wp-content|wp-includes/,
  Webflow: /webflow\.(js|com)/,
  Wix: /static\.wixstatic\.com/,
  Squarespace: /squarespace/,
  Next: /\/_next\/static/,
  Nuxt: /__nuxt|\/_nuxt\//,
  React: /react(-dom)?[.@]/,
  Vue: /vue(\.runtime)?[.@]/,
  HubSpot: /js\.hs-scripts\.com|hs-analytics/,
  Intercom: /widget\.intercom\.io/,
  Drift: /js\.driftt\.com/,
  Segment: /cdn\.segment\.com/,
  Stripe: /js\.stripe\.com/,
  PayPal: /paypal\.com\/sdk/,
  "Google Analytics": /googletagmanager\.com|google-analytics\.com/,
  "Meta Pixel": /connect\.facebook\.net.*fbevents/,
  Hotjar: /static\.hotjar\.com/,
  Cloudflare: /cdn-cgi\//,
  Klaviyo: /static\.klaviyo\.com/,
  Mailchimp: /chimpstatic\.com|list-manage\.com/,
  // Romanian market specifics — worth targeting on directly.
  Gomag: /gomag\.ro/,
  MerchantPro: /merchantpro|shopmania/,
  SmartBill: /smartbill\.ro/,
  Netopia: /netopia-payments|mobilpay/,
  EuPlatesc: /euplatesc\.ro/,
  "eMAG Marketplace": /emag\.ro\/marketplace/,
};

/**
 * Every technology this build can detect, sorted.
 *
 * The competitor picker's vocabulary. Anything outside it can still be named,
 * but it becomes a text-mention signal, which is weaker and noisier.
 */
export const DETECTABLE_TECH: readonly string[] = Object.keys(TECH_MARKERS).sort();

/**
 * Tech detection from markup and headers. Covers the mainstream stacks that
 * matter for ICP targeting and for the "tech stack changed" signal, replacing
 * BuiltWith ($295/mo) and Wappalyzer ($250/mo) for our purposes.
 */
export function fingerprintTech(html: string, headers: Headers): string[] {
  const found = new Set<string>();
  const h = html.toLowerCase();

  for (const [name, re] of Object.entries(TECH_MARKERS)) {
    if (re.test(h)) found.add(name);
  }

  const server = headers.get("server");
  if (server) {
    if (/nginx/i.test(server)) found.add("nginx");
    if (/apache/i.test(server)) found.add("Apache");
    if (/cloudflare/i.test(server)) found.add("Cloudflare");
  }
  if (headers.get("x-powered-by")?.toLowerCase().includes("php")) {
    found.add("PHP");
  }

  return [...found].sort();
}

/**
 * Mailbox names that belong to a function rather than a person.
 *
 * This distinction is legal, not stylistic. Law 506/2004 requires express prior
 * consent for commercial email with no B2B exemption, and a published `office@`
 * is a company's own stated contact route — a materially different object from
 * `ion.popescu@` scraped off a team page.
 */
export const ROLE_PREFIXES = new Set([
  "office",
  "contact",
  "info",
  "hello",
  "sales",
  "vanzari",
  "marketing",
  "support",
  "suport",
  "hr",
  "cariere",
  "jobs",
  "secretariat",
  "comenzi",
  /*
   * The Romanian departmental long tail, added after measuring.
   *
   * A first harvest over 200 sites classified `administratie@`, `comercial@`,
   * `showroom@`, `relatiiclienti@`, `asistenta@` and `welcome@` as *personal*
   * addresses, because the list above only covered the English-centric names an
   * international company uses. Fourteen of the nineteen supposedly personal
   * addresses it stored were departmental.
   *
   * That is not a cosmetic misfiling. A role address reaches a company and a
   * personal one reaches an individual, which is the distinction the whole
   * consent posture rests on — so a departmental address filed as personal is
   * both worse data and a worse legal position.
   */
  "administratie",
  "comercial",
  "showroom",
  "receptie",
  "asistenta",
  "relatii",
  "relatiiclienti",
  "relatiipublice",
  "productie",
  "logistica",
  "depozit",
  "achizitii",
  "aprovizionare",
  "financiar",
  "facturare",
  "contabilitate",
  "juridic",
  "tehnic",
  "service",
  "rezervari",
  "programari",
  "abonamente",
  "welcome",
  "salut",
  "hireme",
  "recrutare",
  "parteneri",
  "colaborari",
  "presa",
  "media",
  "no-reply",
  "noreply",
]);

/**
 * Addresses at this domain found in the markup.
 *
 * `roleOnly` is not an optimisation, it is the difference between two legal
 * objects. Without it, a site with no `office@` falls back to returning *every*
 * same-domain address it can see, personal ones included. That is acceptable
 * when the user is analysing their own site during onboarding — they asked, and
 * it is their data. It is not acceptable when crawling thousands of prospects,
 * where a harvested `ion.popescu@` is personal data collected without consent.
 * So the bulk path passes `roleOnly` and accepts finding nothing.
 */
export function extractEmails(
  html: string,
  domain: string,
  options: { roleOnly?: boolean; all?: boolean } = {},
): string[] {
  const matches =
    html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  const bare = domain.replace(/^www\./, "");

  const relevant = matches
    .map((m) => m.toLowerCase())
    // Ignore addresses at other domains (vendor/agency footers, schema.org samples).
    .filter((m) => m.endsWith(`@${bare}`) || m.endsWith(`.${bare}`))
    .filter((m) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(m));

  const roleOnly = relevant.filter((m) =>
    ROLE_PREFIXES.has(m.split("@")[0].split("+")[0]),
  );

  if (options.roleOnly) return [...new Set(roleOnly)].slice(0, 10);

  /*
   * `all` exists because the default is a *preference*, not a filter, and the
   * difference is easy to miss: without it, a page carrying both `office@` and
   * `ion.popescu@` returns only `office@`, because a non-empty role list wins
   * outright. That is right for onboarding, which wants the company's stated
   * contact route and nothing else.
   *
   * It is wrong for the pattern harvester, whose entire purpose is the personal
   * address — and contact pages are precisely where both appear together, so
   * the preference was silently discarding the sample on the pages most likely
   * to carry one.
   */
  if (options.all) return [...new Set(relevant)].slice(0, 10);

  return [...new Set(roleOnly.length ? roleOnly : relevant)].slice(0, 10);
}

function extractText($: cheerio.CheerioAPI): string {
  $("script, style, noscript, svg, iframe").remove();
  return $("body")
    .text()
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_PER_PAGE);
}

/**
 * Fetch a small set of pages from one site and reduce them to text plus a few
 * structured extras. Returns whatever it could get rather than throwing on
 * partial failure — a site with a dead /pricing is still perfectly analysable.
 */
export async function fetchSiteSnapshot(rawUrl: string): Promise<SiteSnapshot> {
  const url = normaliseUrl(rawUrl);
  const origin = url.origin;
  const domain = url.hostname.replace(/^www\./, "");

  const disallows = await loadRobotsRules(origin);

  // Always try the URL the user actually gave us first.
  const paths = [
    url.pathname !== "/" ? url.pathname : "/",
    ...CANDIDATE_PATHS.filter((p) => p !== url.pathname),
  ];

  const pages: FetchedPage[] = [];
  const techStack = new Set<string>();
  const roleEmails = new Set<string>();
  const socialLinks: SiteSnapshot["socialLinks"] = {};

  for (const path of paths) {
    if (pages.length >= MAX_PAGES) break;
    if (!isAllowed(path, disallows)) continue;

    const res = await fetchWithTimeout(`${origin}${path}`);
    if (!res?.ok) continue;
    if (!res.headers.get("content-type")?.includes("text/html")) continue;

    const raw = await res.text();
    if (raw.length > MAX_BYTES_PER_PAGE) continue;

    const $ = cheerio.load(raw);
    const text = extractText($);
    // Nav-only pages carry no positioning signal and just burn tokens.
    if (text.length < 200) continue;

    pages.push({
      url: `${origin}${path}`,
      title: $("title").first().text().trim() || path,
      text,
    });

    for (const t of fingerprintTech(raw, res.headers)) techStack.add(t);
    for (const e of extractEmails(raw, domain)) roleEmails.add(e);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (!socialLinks.linkedin && /linkedin\.com\/(company|in)\//.test(href)) {
        socialLinks.linkedin = href;
      } else if (!socialLinks.twitter && /(twitter|x)\.com\//.test(href)) {
        socialLinks.twitter = href;
      } else if (!socialLinks.facebook && /facebook\.com\//.test(href)) {
        socialLinks.facebook = href;
      }
    });
  }

  if (pages.length === 0) {
    throw new SiteFetchError(
      `Could not read any readable page from ${domain}. The site may be down, ` +
        `JavaScript-only, or blocking automated requests.`,
      disallows.length ? "blocked_by_robots" : "unreachable",
    );
  }

  return {
    domain,
    origin,
    pages,
    techStack: [...techStack],
    roleEmails: [...roleEmails],
    socialLinks,
  };
}

/** Where a Romanian company publishes its contact address, in order of likelihood. */
const CONTACT_PATHS = ["/", "/contact"];

/**
 * The role addresses published at one prospect's domain.
 *
 * Deliberately not `fetchSiteSnapshot`. That reads five pages, parses each with
 * cheerio, extracts 6,000 characters of text per page and throws when a site is
 * unreadable — all correct for the one-shot analysis of the *user's own* site
 * during onboarding, and all wrong for walking thousands of prospects. Here the
 * only output is a list of addresses, so nothing beyond the regex is needed and
 * two pages carry almost all the yield.
 *
 * Returns `[]` rather than throwing: for prospect crawling, a site that is
 * down, JavaScript-only or blocking us is the ordinary case, not an error the
 * caller can do anything about. The waterfall simply moves on to the next step.
 *
 * Role addresses only — see `extractEmails`. A company with no published
 * `office@` yields nothing here, which is the intended answer.
 */
export async function fetchRoleEmails(rawDomain: string): Promise<string[]> {
  let url: URL;
  try {
    url = normaliseUrl(rawDomain);
  } catch {
    return [];
  }

  const origin = url.origin;
  const domain = url.hostname.replace(/^www\./, "");
  const disallows = await loadRobotsRules(origin);
  const found = new Set<string>();

  for (const path of CONTACT_PATHS) {
    if (!isAllowed(path, disallows)) continue;

    const res = await fetchWithTimeout(`${origin}${path}`);
    if (!res?.ok) continue;
    if (!res.headers.get("content-type")?.includes("text/html")) continue;

    const raw = await res.text();
    if (raw.length > MAX_BYTES_PER_PAGE) continue;

    for (const address of extractEmails(raw, domain, { roleOnly: true })) {
      found.add(address);
    }
    // The home page usually carries the footer address; a hit there means the
    // /contact fetch buys nothing.
    if (found.size > 0) break;
  }

  return [...found];
}

/**
 * Pages where a Romanian company publishes named staff, in order of yield.
 *
 * Wider than `CONTACT_PATHS` because the target is different. That one wants
 * `office@` and stops at the first hit, since the footer usually carries it.
 * This one wants as many *named* addresses as it can find, because two samples
 * at a domain settle a convention that one leaves ambiguous.
 */
const TEAM_PATHS = [
  "/contact",
  "/contacte",
  "/echipa",
  "/team",
  "/despre-noi",
  "/about",
  "/management",
  "/conducere",
  "/",
];

/** Enough pages to find a second sample, few enough to stay a polite guest. */
const MAX_TEAM_PAGES = 5;
/**
 * Two confirmed samples make a convention; a third adds little.
 * `inferDominantPattern` already caps its confidence at three.
 */
const ENOUGH_SAMPLES = 3;

export type HarvestedAddress = {
  address: string;
  /** The page it was published on — provenance, and what a DSAR needs. */
  sourceUrl: string;
  isRole: boolean;
};

/**
 * Every address published at one domain, role and personal alike.
 *
 * The distinction `fetchRoleEmails` enforces is deliberately *not* enforced
 * here, and the difference matters legally, so it is worth being explicit about
 * which caller is which. `fetchRoleEmails` runs over every prospect in the
 * register and returns only what a company publishes as its own contact route.
 * This runs on the enrichment path, where the goal is a named contact and the
 * user has accepted that posture; the addresses it returns carry `sourceUrl` so
 * every one of them can be traced back to the page that published it.
 *
 * Returns `[]` rather than throwing, for the same reason `fetchRoleEmails`
 * does: a site that is down or JavaScript-only is the ordinary case.
 */
export type ContactHarvest = {
  addresses: HarvestedAddress[];
  /**
   * How many distinct pages were actually read.
   *
   * The caller needs this to tell two very different outcomes apart, and
   * returning a bare array made them identical. **Zero pages** means we learned
   * nothing — the site was down, blocked us, or the network failed — and asking
   * again later is worth it. **Pages read, no addresses** is a real answer: this
   * company does not publish an address, and re-crawling it forever is waste.
   *
   * Conflating them cost a full pass over 3,333 domains: a run degraded to 0.2%
   * reachable (against 15% on the same domains sampled fresh), and every one of
   * them was recorded as "checked, nothing here" and so excluded from retry.
   */
  pagesRead: number;
};

export async function fetchContactAddresses(
  rawDomain: string,
): Promise<ContactHarvest> {
  let url: URL;
  try {
    url = normaliseUrl(rawDomain);
  } catch {
    // A malformed domain is a settled answer, not a transient failure — but it
    // has no page behind it either, so it reports as unreadable and the caller
    // decides. Nothing about it will change on a retry.
    return { addresses: [], pagesRead: 0 };
  }

  const origin = url.origin;
  const domain = url.hostname.replace(/^www\./, "");
  const disallows = await loadRobotsRules(origin);

  const found = new Map<string, HarvestedAddress>();
  const seenBodies = new Set<string>();
  let pagesRead = 0;

  for (const path of TEAM_PATHS) {
    if (pagesRead >= MAX_TEAM_PAGES) break;
    if (!isAllowed(path, disallows)) continue;

    const res = await fetchWithTimeout(`${origin}${path}`);
    if (!res?.ok) continue;
    if (!res.headers.get("content-type")?.includes("text/html")) continue;

    const raw = await res.text();
    if (raw.length > MAX_BYTES_PER_PAGE) continue;

    /*
     * Soft-404 sites serve the same homepage for every path, so `/contact`,
     * `/echipa` and `/team` all come back 200 with identical bytes and spend
     * the whole five-page budget before `/about` or `/` is ever tried. Skipping
     * a body we have already read costs one cheap comparison and buys back
     * four page slots on exactly the sites that need them most.
     */
    const fingerprint = `${raw.length}:${raw.slice(0, 512)}`;
    if (seenBodies.has(fingerprint)) continue;
    seenBodies.add(fingerprint);

    pagesRead += 1;

    const sourceUrl = `${origin}${path}`;
    // `all`, not the default preference: the personal address is the point
    // here, and a page carrying `office@` alongside it would otherwise return
    // only the role one.
    for (const address of extractEmails(raw, domain, { all: true })) {
      // First page wins the provenance: if `office@` appears in the footer of
      // every page, the URL recorded should be where it was actually read.
      if (found.has(address)) continue;
      found.set(address, { address, sourceUrl, isRole: isRolePrefix(address) });
    }

    const personal = [...found.values()].filter((entry) => !entry.isRole);
    if (personal.length >= ENOUGH_SAMPLES) break;
  }

  return { addresses: [...found.values()], pagesRead };
}

/**
 * Local copy of the role test, rather than importing `isRoleAddress` from
 * `enrichment/patterns.ts`.
 *
 * `ROLE_PREFIXES` in this file is the list `extractEmails` already partitions
 * on, so using anything else here would let an address be classified one way
 * on the way out of the crawler and the other way on the way into the database.
 */
function isRolePrefix(address: string): boolean {
  const local = address.split("@")[0].split("+")[0];
  if (ROLE_PREFIXES.has(local)) return true;

  /*
   * Qualified role addresses: `office-vw@`, `vanzari.bucuresti@`,
   * `contact_cluj@`. A dealership with one mailbox per brand or one per branch
   * is common here, and every one of them was being filed as a *personal*
   * address because the local part is not exactly `office`.
   *
   * Only the leading segment is consulted, so `ion.popescu@` is untouched —
   * `ion` is nobody's department. The direction of error matters: calling a
   * departmental address personal overstates what we hold about an individual,
   * which is the wrong way round for the consent posture.
   */
  const head = local.split(/[-._]/)[0];
  return head.length > 0 && ROLE_PREFIXES.has(head);
}
