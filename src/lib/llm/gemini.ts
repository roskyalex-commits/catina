import type { z } from "zod";
import { toGeminiSchema } from "./gemini-schema";
import { LlmError, type ExtractInput, type StructuredExtractor } from "./types";

/**
 * Google Gemini, over the REST API.
 *
 * Here because it has a genuinely usable free tier and the ICP analysis is the
 * first screen a new user sees — "you need a paid Anthropic account before the
 * product does anything" is a bad first impression for a tool whose whole pitch
 * is that its data sources are free.
 *
 * REST rather than `@google/generative-ai`: the call is one POST with a JSON
 * body, the deploy target is Cloudflare Workers where every dependency is
 * bundle weight, and the SDK's value is streaming and chat history — neither of
 * which this product uses.
 *
 * Claude stays the default when both keys are present. This is the fallback,
 * and Flash is chosen over Pro because the task is extraction against a schema
 * rather than reasoning, and Flash is what the free tier is generous with.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
/*
 * Google's own recommendation, taken from the migration message the API
 * returns. `gemini-2.5-flash` was the default here and is closed to new keys —
 * it still appears in `models.list`, so the only way to find out is to call it
 * and read the 404. Pinned rather than `gemini-flash-latest`, because a model
 * that changes underneath us would silently change every ICP the product
 * produces. Override with `GEMINI_MODEL` when a newer Flash is worth moving to.
 */
const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_MAX_TOKENS = 16_000;
/**
 * Room for the model to think, on top of whatever the caller asked for.
 *
 * `maxOutputTokens` counts reasoning tokens as well as answer tokens, and
 * Gemini 3.x reasons on every request whether the task needs it or not.
 * Measured on `gemini-3.6-flash` asking for six keywords: a 500-token cap spent
 * **480 on thinking** and produced 5 tokens of answer before hitting
 * MAX_TOKENS. The same request at 4,000 spent 621 thinking and answered in 66.
 *
 * `thinkingConfig: { thinkingBudget: 0 }` is not a way out — this model rejects
 * it with a 400.
 *
 * So the adapter adds the headroom rather than the caller. `maxOutputTokens` in
 * `ExtractInput` means "tokens of answer" for every provider, which is what
 * Anthropic's `max_tokens` already means; a caller asking for a short list
 * should not have to know that one vendor bills its own deliberation to that
 * budget. Three times the observed cost, because reasoning scales with the
 * schema and the ICP schema is far bigger than a keyword list.
 */
const THINKING_HEADROOM = 2_048;
const TIMEOUT_MS = 60_000;

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { thoughtsTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
};

export class GeminiExtractor implements StructuredExtractor {
  readonly key = "gemini";
  readonly label = "Gemini (GEMINI_API_KEY)";

  private readonly apiKey?: string;
  private readonly model: string;

  /*
   * Blank is unset, for both of these.
   *
   * A default parameter only fires on `undefined`, and dotenv parses
   * `GEMINI_MODEL=` as `""` — so a commented-out-by-blanking line sailed past
   * the default and built `.../models/:generateContent`, which Google answers
   * with a 404 that reads exactly like a wrong model name. `.env.example`
   * ships that line blank, so every fresh setup starts in that state.
   *
   * `getEnv()` already strips empty values for this reason; this guard is here
   * because a constructor cannot assume its caller went through it.
   */
  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey?.trim() || undefined;
    this.model = model?.trim() || DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async extract<T extends z.ZodType>(input: ExtractInput<T>): Promise<z.infer<T>> {
    if (!this.apiKey) {
      throw new LlmError(this.key, "not_configured", "GEMINI_API_KEY is not set.");
    }

    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(input.schema),
        maxOutputTokens:
          (input.maxOutputTokens ?? DEFAULT_MAX_TOKENS) + THINKING_HEADROOM,
        // Extraction, not writing. The same page should give the same ICP.
        temperature: 0,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${BASE}/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A header, not a query parameter: a key in the URL ends up in proxy
          // logs and error messages.
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new LlmError(
        this.key,
        "upstream",
        error instanceof Error && error.name === "AbortError"
          ? `Gemini did not answer within ${TIMEOUT_MS / 1000}s.`
          : String(error),
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as GeminiResponse;

    if (!response.ok) {
      throw new LlmError(
        this.key,
        response.status === 429 ? "quota" : "upstream",
        payload.error?.message ?? `${response.status} ${response.statusText}`,
        response.status,
      );
    }

    if (payload.promptFeedback?.blockReason) {
      throw new LlmError(
        this.key,
        "refused",
        `Blocked: ${payload.promptFeedback.blockReason}.`,
      );
    }

    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") {
      /*
       * Say where the budget went. A bare "cut short" sent the last reader
       * probing the API by hand to discover that reasoning had eaten 96% of it.
       */
      const thoughts = payload.usageMetadata?.thoughtsTokenCount;
      const answer = payload.usageMetadata?.candidatesTokenCount;
      throw new LlmError(
        this.key,
        "truncated",
        thoughts === undefined
          ? "The response was cut short."
          : `The response was cut short: ${thoughts} tokens went on reasoning ` +
            `and ${answer ?? 0} on the answer. Raise maxOutputTokens.`,
      );
    }
    if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "RECITATION") {
      throw new LlmError(this.key, "refused", `Stopped: ${candidate.finishReason}.`);
    }

    /*
     * Parts are concatenated rather than indexed at [0]. Gemini splits a long
     * JSON body across parts often enough that reading only the first one
     * produces a truncated object and an unparseable error that looks like a
     * model failure rather than a client bug.
     */
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new LlmError(this.key, "unparseable", "Gemini returned an empty response.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripFence(text));
    } catch {
      throw new LlmError(
        this.key,
        "unparseable",
        `Gemini returned text that is not JSON: ${text.slice(0, 200)}`,
      );
    }

    /*
     * Validated against the Zod schema here, not trusted.
     *
     * `responseSchema` constrains the shape but not the semantics — a `minItems`
     * Gemini's subset dropped, or a regex it never saw, is still checked by the
     * caller's schema. The Anthropic path gets this from `zodOutputFormat`; this
     * path has to do it explicitly, or the two providers would disagree about
     * what counts as a valid answer.
     */
    const parsed = input.schema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new LlmError(
        this.key,
        "unparseable",
        `Gemini's answer did not fit the schema: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data as z.infer<T>;
  }
}

/** Gemini occasionally wraps JSON in a markdown fence despite the mime type. */
function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return fenced ? fenced[1] : text;
}
