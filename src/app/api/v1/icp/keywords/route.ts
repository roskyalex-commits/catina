import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { NO_LLM_CONFIGURED, preferredExtractor } from "@/lib/llm/registry";
import { LlmError } from "@/lib/llm/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/v1/icp/keywords — suggest topics to match against prospect sites.
 *
 * The signal picker's "Suggest keywords" button. Its own route rather than part
 * of the ICP analysis because it is clicked repeatedly and independently: the
 * user adds two keywords, wants three more, and re-running the whole site
 * analysis to get them would re-crawl the site and cost sixteen thousand tokens
 * for a fifteen-word answer.
 *
 * ## The cost shape
 *
 * A few hundred tokens with a small output cap, deliberately unlike
 * `analyze.ts`. Whichever provider is configured runs it — on Gemini's free
 * tier this button costs nothing at all, which is much of why the provider seam
 * exists.
 *
 * ## What makes a good keyword here
 *
 * `KeywordSiteSignalSource` matches whole words against a prospect's *own*
 * pages, so the useful keyword is one a buyer would put on their site, not one
 * a seller would bid on. "magazin online" is a good keyword; "best invoicing
 * software Romania" matches nothing, ever. The prompt spends most of its length
 * on that distinction because it is the one thing a model gets wrong here.
 */

const bodySchema = z.object({
  valueProp: z.string().trim().min(10).max(400),
  industries: z.array(z.string().max(80)).max(15).default([]),
  existing: z.array(z.string().max(60)).max(20).default([]),
});

const suggestionSchema = z.object({
  keywords: z
    .array(z.string())
    .describe(
      "6-10 short Romanian or English phrases a BUYER would have on their own " +
        "website. One to three words each. No brand names, no questions, no " +
        "marketing slogans.",
    ),
});

const SYSTEM_PROMPT = `You pick keywords for a sales-prospecting tool that matches them against a prospect company's own website — its homepage, about page and product pages.

A good keyword is a phrase the BUYER would write about themselves. If you are helping someone who sells invoicing software, good keywords are what their customers say they do: "magazin online", "distributie", "contabilitate primara". Bad keywords are what the seller would say: "invoicing software", "best ERP", "automate your billing" — no prospect writes that on their own site.

Rules:
- One to three words. Longer phrases match nothing.
- Prefer the language the prospects' sites are written in. For Romanian buyers that means Romanian, including words with diacritics — matching handles both spellings.
- No brand or product names. Those are handled separately as competitors.
- No generic business words on their own ("solutions", "quality", "professional") — they appear on every site and would match everything.
- Avoid two-letter words entirely, and be sparing with short acronyms: they are matched case-sensitively and only worth it when genuinely distinctive.

Return only the keywords.`;

export async function POST(request: Request) {
  const extractor = preferredExtractor(getEnv());
  if (!extractor) {
    return NextResponse.json(
      { error: NO_LLM_CONFIGURED, code: "not_configured" },
      { status: 503 },
    );
  }

  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Send { valueProp, industries?, existing? }." },
      { status: 400 },
    );
  }

  const user = [
    `What they sell: ${input.valueProp}`,
    input.industries.length ? `Buyer industries: ${input.industries.join(", ")}` : null,
    input.existing.length
      ? `Already chosen, do not repeat: ${input.existing.join(", ")}`
      : null,
    "Suggest keywords to look for on a prospect's own website.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const result = await extractor.extract({
      system: SYSTEM_PROMPT,
      user,
      schema: suggestionSchema,
      schemaName: "keywords",
      // A short list. Without a cap this inherits the 16k default meant for a
      // full ICP, which on a metered provider is a real cost for no benefit.
      maxOutputTokens: 500,
    });

    const seen = new Set(input.existing.map((keyword) => keyword.toLowerCase()));
    const keywords = result.keywords
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length >= 3 && keyword.length <= 60)
      // The model is told not to repeat what is already chosen, and told again
      // here — the instruction is a request, the filter is a guarantee.
      .filter((keyword) => {
        const lower = keyword.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      })
      .slice(0, 10);

    return NextResponse.json({ keywords, provider: extractor.key });
  } catch (error) {
    if (error instanceof LlmError && error.reason === "quota") {
      return NextResponse.json(
        { error: `${extractor.label} is out of quota. Add keywords by hand for now.` },
        { status: 429 },
      );
    }
    console.error("Keyword suggestion failed", { provider: extractor.key, error });
    return NextResponse.json(
      { error: "Could not suggest keywords. Add a few by hand instead." },
      { status: 502 },
    );
  }
}
