import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeSnapshot } from "@/lib/icp/analyze";
import { SiteFetchError, fetchSiteSnapshot } from "@/lib/crawl/fetch-site";
import { getEnv } from "@/lib/env";

/**
 * POST /api/v1/icp/analyze — the onboarding magic moment.
 *
 * Unauthenticated on purpose: this runs on the landing page before signup, the
 * way Gojiberry's does. That makes it the one route a stranger can spend our
 * Claude budget on, so it is rate limited per IP below.
 *
 * Routes live under /api/v1 and stay JSON-first so an Expo client can be added
 * later without a refactor (the repo is named `Mobile`).
 */

const bodySchema = z.object({
  url: z.string().min(3).max(2048),
});

/**
 * In-memory limiter. Adequate while this runs as a single Worker isolate; move
 * to the CACHE KV binding before this sees real traffic, since isolates are
 * per-region and this map does not survive an eviction.
 */
const RATE_LIMIT = { windowMs: 60_000, max: 3 };
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT.windowMs,
  );
  recent.push(now);
  hits.set(ip, recent);

  // Opportunistic sweep so the map can't grow without bound.
  if (hits.size > 10_000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_LIMIT.windowMs)) hits.delete(key);
    }
  }
  return recent.length > RATE_LIMIT.max;
}

export async function POST(request: Request) {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown";

  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many analyses. Wait a minute and try again." },
      { status: 429 },
    );
  }

  let url: string;
  try {
    url = bodySchema.parse(await request.json()).url;
  } catch {
    return NextResponse.json(
      { error: "Send a JSON body of the shape { url: string }." },
      { status: 400 },
    );
  }

  /*
   * Resolve the key before fetching anything.
   *
   * Two reasons it comes first. There is no point crawling someone's website
   * when the analysis cannot run afterwards; and a missing key is a
   * configuration problem, not a transient one, so it must not fall into the
   * catch below and be reported as "try again in a moment" — advice that will
   * never come true and sends the reader looking in the wrong place.
   */
  const apiKey = getEnv().ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Site analysis needs an Anthropic API key. Copy .env.example to " +
          ".env.local, set ANTHROPIC_API_KEY, and restart the dev server. " +
          "The rest of the app runs on demo data at /app without it.",
        code: "not_configured",
      },
      { status: 503 },
    );
  }

  try {
    const snapshot = await fetchSiteSnapshot(url);
    const result = await analyzeSnapshot(snapshot, apiKey);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SiteFetchError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "invalid_url" ? 400 : 422 },
      );
    }
    console.error("ICP analysis failed", { url, error });
    return NextResponse.json(
      { error: "Could not analyse that site. Try again in a moment." },
      { status: 500 },
    );
  }
}
