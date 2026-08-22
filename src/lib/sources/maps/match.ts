import { companyMatches } from "@/lib/sources/brightdata/match";

/**
 * Deciding which registry company a Google Maps listing belongs to.
 *
 * A listing carries a name, an address, a phone number and sometimes a website.
 * It carries no CUI, so it has to be matched back to a company we already hold
 * — and the cost of getting that wrong is a stranger's website attached to a
 * lead, which looks exactly like a correct one.
 *
 * ## Why phone is the primary key
 *
 * Measured on the live database: of 11,302 distinct normalised phone numbers,
 * **10,763 belong to exactly one company — 95.2%**. The worst case is 26
 * companies sharing a number (an accountant's office, or a group's switchboard),
 * which is why a shared number falls through to the name check rather than
 * picking the first row.
 *
 * 76.7% of those numbers are mobile (`07…`), which for a Romanian SRL is
 * usually the administrator's own line and is close to a personal identifier.
 *
 * ## The tiers, in order
 *
 * 1. **Phone**, when it resolves to exactly one company. Effectively exact.
 * 2. **Name + county**, via `companyMatches` — already written for the Bright
 *    Data join, already strict, already tested against real registry names.
 * 3. **CUI printed on the website**, as a *confirmation* rather than a lookup.
 *    Measured on 38 reachable company sites whose CUI we knew: 5 published one
 *    and **all 5 matched**, so it is 100% precise and ~13% recall. Too sparse to
 *    find a company with; perfect for proving a match found another way.
 */

/**
 * Fold a phone number to compare it.
 *
 * ANAF and Google write the same number differently — `0264595091`,
 * `021.351.35.30`, `+40 264 595 091`. Everything but the digits comes out, and
 * a `40` country prefix becomes the national `0` so both sides land in the same
 * shape.
 */
export function normalisePhone(raw: string | null | undefined): string | undefined {
  if (!raw?.trim()) return undefined;

  // A field holding two numbers separated by a slash or comma is one company
  // with two lines. The first is the one both sources are most likely to list.
  const first = raw.split(/[/,;]| sau /i)[0] ?? "";
  let digits = first.replace(/\D/g, "");

  // +40 264 … and 0264 … are the same line. `0040` too.
  if (digits.startsWith("0040")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("40") && digits.length >= 11) digits = `0${digits.slice(2)}`;

  // A Romanian number is 10 digits starting 0. Shorter is a filing artefact;
  // longer is a typo we cannot repair, and matching on a typo is worse than
  // not matching.
  return digits.length === 10 && digits.startsWith("0") ? digits : undefined;
}

export type RegistryCompany = {
  id: string;
  name: string;
  county?: string | null;
  phone?: string | null;
  domain?: string | null;
};

export type MatchVerdict =
  | { matched: true; companyId: string; by: "phone" | "name"; reason: string }
  | { matched: false; reason: string };

/**
 * An index built once per run, not a query per place.
 *
 * A Maps scrape returns thousands of listings and the registry side is hundreds
 * of thousands of rows; a lookup each is how this becomes an N+1 against a
 * hosted database.
 */
export class RegistryIndex {
  private readonly byPhone = new Map<string, string[]>();
  private readonly byCounty = new Map<string, RegistryCompany[]>();

  constructor(companies: readonly RegistryCompany[]) {
    for (const company of companies) {
      const phone = normalisePhone(company.phone);
      if (phone) {
        this.byPhone.set(phone, [...(this.byPhone.get(phone) ?? []), company.id]);
      }
      const county = normaliseCounty(company.county);
      this.byCounty.set(county, [...(this.byCounty.get(county) ?? []), company]);
    }
  }

  /** How many numbers point at exactly one company — the join's own quality. */
  phoneStats(): { distinct: number; unique: number } {
    let unique = 0;
    for (const ids of this.byPhone.values()) if (ids.length === 1) unique += 1;
    return { distinct: this.byPhone.size, unique };
  }

  match(place: {
    name?: string;
    phone?: string;
    county?: string | null;
  }): MatchVerdict {
    const phone = normalisePhone(place.phone);
    if (phone) {
      const ids = this.byPhone.get(phone);
      if (ids?.length === 1) {
        return { matched: true, companyId: ids[0], by: "phone", reason: `phone ${phone}` };
      }
      if (ids && ids.length > 1) {
        /*
         * A switchboard or an accountant's office. Falling through to the name
         * check is right; picking the first would attach a listing to whichever
         * company happened to sort first, silently.
         */
        const narrowed = this.matchByName(place, ids);
        if (narrowed) return narrowed;
        return {
          matched: false,
          reason: `phone ${phone} is shared by ${ids.length} companies and the name did not settle it`,
        };
      }
    }

    const byName = this.matchByName(place);
    if (byName) return byName;

    return {
      matched: false,
      reason: phone ? "no company with that phone or name" : "no phone, and the name did not match",
    };
  }

  /**
   * Name within the county, and only when it is unambiguous.
   *
   * Two candidates means we cannot tell, and `companyMatches` is deliberately
   * strict — it refuses a pair sharing only generic words like `romania` or
   * `trade`, because accepting those is how a stranger ends up on a lead.
   */
  private matchByName(
    place: { name?: string; county?: string | null },
    restrictTo?: readonly string[],
  ): MatchVerdict | null {
    if (!place.name?.trim()) return null;

    const pool = restrictTo
      ? [...this.byCounty.values()].flat().filter((c) => restrictTo.includes(c.id))
      : (this.byCounty.get(normaliseCounty(place.county)) ?? []);

    const hits = pool.filter((company) => companyMatches(company.name, place.name).matched);
    if (hits.length !== 1) return null;

    return {
      matched: true,
      companyId: hits[0].id,
      by: "name",
      reason: `name "${place.name}" in ${hits[0].county ?? "?"}`,
    };
  }
}

function normaliseCounty(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t")
    .trim()
    .toLowerCase();
}

/**
 * Every CUI a page states about itself.
 *
 * Romanian companies print `CUI: RO12345678` or `C.I.F. 12345678` in a footer or
 * on a terms page. Only about one site in eight does — measured at 5 of 38
 * reachable sites — but when one does, it matched the register **every time**.
 * So this confirms a match rather than making one.
 */
const CUI_PATTERN =
  /\b(?:C\.?U\.?I\.?|C\.?I\.?F\.?|cod\s+unic\s+de\s+[îi]nregistrare|cod\s+fiscal)\s*:?\s*(?:RO)?\s*(\d{2,10})\b/gi;

export function cuisStatedOn(html: string): Set<string> {
  const found = new Set<string>();
  const text = html.replace(/<[^>]+>/g, " ");
  CUI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CUI_PATTERN.exec(text)) !== null) {
    found.add(match[1].replace(/^0+/, ""));
  }
  return found;
}
