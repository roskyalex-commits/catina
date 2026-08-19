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
 * Tech detection from markup and headers. Covers the mainstream stacks that
 * matter for ICP targeting and for the "tech stack changed" signal, replacing
 * BuiltWith ($295/mo) and Wappalyzer ($250/mo) for our purposes.
 */
export function fingerprintTech(html: string, headers: Headers): string[] {
  const found = new Set<string>();
  const h = html.toLowerCase();

  const markers: Record<string, RegExp> = {
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

  for (const [name, re] of Object.entries(markers)) {
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

const ROLE_PREFIXES = new Set([
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
]);

function extractEmails(html: string, domain: string): string[] {
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
