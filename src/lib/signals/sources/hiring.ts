import * as cheerio from "cheerio";
import type { Signal, SignalScanContext, SignalSource } from "../types";
import { scoreTitleMatch } from "@/lib/sources/people/seniority";

/**
 * Hiring signals from a company's own careers page.
 *
 * The strongest free signal in the set: a company hiring is a company with
 * budget, and a company hiring *your buyer* is a company about to have a new
 * decision-maker who needs tools. Reading their own page rather than a job
 * board keeps this free and avoids scraping a third party.
 *
 * Two distinct signals come out of it:
 *   - hiring_surge     — headcount growth generally
 *   - hiring_buyer_role — a role matching the ICP's target titles, which is
 *     much stronger and gives outreach a specific hook
 */

const CAREERS_PATHS = [
  "/careers",
  "/cariere",
  "/jobs",
  "/joburi",
  "/about/careers",
  "/company/careers",
  "/posturi",
];

const USER_AGENT =
  "CatinaBot/0.1 (+https://catina.ro/bot; B2B lead research; contact@catina.ro)";
const TIMEOUT_MS = 10_000;

export class HiringSignalSource implements SignalSource {
  readonly key = "hiring";
  readonly label = "Hiring activity";
  readonly description =
    "Reads the company's own careers page. A company hiring has budget; a " +
    "company hiring your buyer is about to have a new decision-maker.";

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.domain);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const domain = context.company.domain;
    if (!domain) return [];

    const page = await this.findCareersPage(domain);
    if (!page) return [];

    const titles = extractJobTitles(page.html);
    if (titles.length === 0) return [];

    const detectedAt = new Date();
    const signals: Signal[] = [];
    const previous = context.previous?.careersJobTitles ?? [];
    const newTitles = titles.filter((t) => !previous.includes(t));

    // --- Surge: only meaningful against a previous scan --------------------
    if (previous.length > 0 && newTitles.length >= 2) {
      signals.push({
        type: "hiring_surge",
        title: `${newTitles.length} new roles posted (${titles.length} open)`,
        evidenceUrl: page.url,
        // More new roles is a stronger signal, saturating around five.
        strength: Math.min(0.85, 0.4 + newTitles.length * 0.1),
        detectedAt,
        dedupeKey: `hiring_surge:${domain}:${detectedAt.toISOString().slice(0, 10)}`,
        payload: { newTitles, openCount: titles.length },
      });
    }

    // --- Buyer-shaped role: strong even on a first scan --------------------
    const targetTitles = context.targetTitles ?? [];
    if (targetTitles.length > 0) {
      // Only consider roles that are new, unless this is the first scan —
      // otherwise a long-open role re-fires the same signal every week.
      const pool = previous.length > 0 ? newTitles : titles;
      const match = pool.find(
        (title) =>
          scoreTitleMatch(title, { targetTitles, targetSeniorities: [] }) >= 0.85,
      );

      if (match) {
        signals.push({
          type: "hiring_buyer_role",
          title: `Hiring a ${match} — your buyer, arriving soon`,
          evidenceUrl: page.url,
          strength: 0.95,
          detectedAt,
          dedupeKey: `hiring_role:${domain}:${slug(match)}`,
          payload: { role: match },
        });
      }
    }

    return signals;
  }

  /** Tries the conventional careers paths, first hit wins. */
  private async findCareersPage(
    domain: string,
  ): Promise<{ url: string; html: string } | null> {
    const origin = `https://${domain.replace(/^www\./, "")}`;

    for (const path of CAREERS_PATHS) {
      const url = `${origin}${path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          headers: { "user-agent": USER_AGENT, accept: "text/html" },
          redirect: "follow",
          signal: controller.signal,
        });

        if (!response.ok) continue;
        if (!response.headers.get("content-type")?.includes("text/html")) continue;

        const html = await response.text();
        // A soft-404 returns 200 with the homepage; require something that
        // actually reads like a job listing before treating it as a hit.
        if (!/job|position|rol|post|cariera|carieră|vacan/i.test(html)) continue;

        return { url, html };
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}

/**
 * Pulls plausible job titles out of a careers page.
 *
 * Careers pages have no common markup, so this looks where titles usually live
 * — headings and link text — and then filters hard on shape. Over-extracting
 * would turn navigation links into phantom job openings.
 */
export function extractJobTitles(html: string): string[] {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header").remove();

  const candidates = new Set<string>();

  $("h2, h3, h4, a, li").each((_, element) => {
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (isPlausibleJobTitle(text)) candidates.add(text);
  });

  return [...candidates].slice(0, 40);
}

const JOB_WORDS =
  /\b(engineer|developer|manager|director|designer|analyst|specialist|lead|architect|consultant|officer|executive|coordinator|administrator|accountant|marketer|programator|inginer|dezvoltator|contabil|consultant|responsabil|coordonator|vanzari|vânzări|sef|șef)\b/i;

const NON_JOB =
  /\b(cookie|privacy|terms|policy|newsletter|subscribe|contact us|about us|log ?in|sign ?up|read more|apply now|see all|view all|politica|termeni|abonare)\b/i;

export function isPlausibleJobTitle(text: string): boolean {
  if (text.length < 4 || text.length > 80) return false;
  // A sentence is a description, not a title.
  if (text.split(/\s+/).length > 9) return false;
  if (NON_JOB.test(text)) return false;
  if (!JOB_WORDS.test(text)) return false;
  // Titles are words, not prose — reject anything sentence-like.
  if (/[.!?]$/.test(text)) return false;
  return true;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
