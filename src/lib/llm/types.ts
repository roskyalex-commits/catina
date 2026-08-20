import type { z } from "zod";

/**
 * The one thing this product asks a language model to do: fill a schema.
 *
 * Every LLM call in Cătină is structured extraction — website text in, a typed
 * object out. Nothing streams, nothing is conversational, nothing needs tools.
 * That narrowness is what makes a provider seam worth having: the interface is
 * four lines, and swapping vendors changes no caller.
 *
 * It exists because `ANTHROPIC_API_KEY` was the single point of failure for the
 * only screen a new user sees. Claude is the better model for this and stays
 * the default when its key is present, but "the ICP analysis cannot run at all"
 * is a much worse outcome than "the ICP analysis ran on a free tier".
 *
 * ## What an implementation owes the caller
 *
 * A parsed object that satisfies `schema`, or a thrown `LlmError`. Providers
 * differ wildly in how they fail — a refusal, a truncation, a malformed JSON
 * body, a quota — and the caller cannot sensibly branch on nine vendor shapes.
 * They are collapsed into `reason` here so the route can say something true.
 */

export type LlmFailure =
  | "not_configured"
  | "refused"
  | "truncated"
  | "unparseable"
  | "quota"
  | "upstream";

export class LlmError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: LlmFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type ExtractInput<T extends z.ZodType> = {
  system: string;
  user: string;
  schema: T;
  /** A name for the schema. Some providers require one; others ignore it. */
  schemaName: string;
  maxOutputTokens?: number;
};

export interface StructuredExtractor {
  readonly key: string;
  /** Shown in logs and in the setup error, so a user knows which key ran. */
  readonly label: string;
  isConfigured(): boolean;
  extract<T extends z.ZodType>(input: ExtractInput<T>): Promise<z.infer<T>>;
}
