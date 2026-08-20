import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { LlmError, type ExtractInput, type StructuredExtractor } from "./types";

/**
 * Claude, via the SDK's own Zod helper.
 *
 * The default when its key is present: it handles a long, messy page dump and a
 * fifteen-field schema more reliably than anything else tried, and
 * `zodOutputFormat` means the schema the app validates against is literally the
 * schema the model is constrained by — no second representation to drift.
 */

const DEFAULT_MAX_TOKENS = 16_000;

export class AnthropicExtractor implements StructuredExtractor {
  readonly key = "anthropic";
  readonly label = "Claude (ANTHROPIC_API_KEY)";

  private readonly apiKey?: string;

  /** Blank is unset — see the note in `gemini.ts`. */
  constructor(apiKey?: string) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async extract<T extends z.ZodType>(input: ExtractInput<T>): Promise<z.infer<T>> {
    if (!this.apiKey) {
      throw new LlmError(this.key, "not_configured", "ANTHROPIC_API_KEY is not set.");
    }

    const client = new Anthropic({ apiKey: this.apiKey });

    let message;
    try {
      message = await client.messages.parse({
        model: "claude-opus-5",
        max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        system: input.system,
        messages: [{ role: "user", content: input.user }],
        output_config: { format: zodOutputFormat(input.schema) },
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new LlmError(
        this.key,
        status === 429 ? "quota" : "upstream",
        error instanceof Error ? error.message : String(error),
        status,
      );
    }

    if (message.stop_reason === "refusal") {
      throw new LlmError(this.key, "refused", "The model declined this request.");
    }
    if (message.stop_reason === "max_tokens") {
      throw new LlmError(this.key, "truncated", "The response was cut short.");
    }
    if (!message.parsed_output) {
      throw new LlmError(this.key, "unparseable", "No structured output came back.");
    }
    return message.parsed_output as z.infer<T>;
  }
}
