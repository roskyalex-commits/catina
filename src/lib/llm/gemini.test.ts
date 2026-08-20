import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GeminiExtractor } from "./gemini";
import { LlmError } from "./types";

/**
 * The adapter cannot be exercised against the real API here, so what is tested
 * is everything between the HTTP response and the caller — which is where the
 * bugs in a REST adapter actually live. Each case below is a shape Gemini
 * genuinely returns.
 */

const schema = z.object({
  name: z.string(),
  tags: z.array(z.string()),
});

function respond(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** A well-formed success, with the JSON split across `parts` as Gemini does. */
function candidate(parts: string[], finishReason = "STOP") {
  return { candidates: [{ content: { parts: parts.map((text) => ({ text })) }, finishReason }] };
}

afterEach(() => vi.unstubAllGlobals());

async function run(fetchImpl: ReturnType<typeof respond>) {
  vi.stubGlobal("fetch", fetchImpl);
  return new GeminiExtractor("test-key").extract({
    system: "s",
    user: "u",
    schema,
    schemaName: "t",
  });
}

describe("configuration", () => {
  it("reports itself unconfigured without a key", () => {
    expect(new GeminiExtractor(undefined).isConfigured()).toBe(false);
    expect(new GeminiExtractor("k").isConfigured()).toBe(true);
  });

  it("refuses to call without one rather than sending an empty header", async () => {
    await expect(
      new GeminiExtractor(undefined).extract({
        system: "s",
        user: "u",
        schema,
        schemaName: "t",
      }),
    ).rejects.toMatchObject({ reason: "not_configured" });
  });
});

describe("reading the response", () => {
  it("parses a normal answer", async () => {
    const result = await run(respond(candidate([JSON.stringify({ name: "a", tags: ["x"] })])));
    expect(result).toEqual({ name: "a", tags: ["x"] });
  });

  it("joins parts, because Gemini splits long JSON across them", async () => {
    // Reading only parts[0] yields half an object and an "unparseable" error
    // that looks like a model failure rather than a client bug.
    const json = JSON.stringify({ name: "split", tags: ["a", "b"] });
    const middle = Math.floor(json.length / 2);
    const result = await run(
      respond(candidate([json.slice(0, middle), json.slice(middle)])),
    );
    expect(result).toEqual({ name: "split", tags: ["a", "b"] });
  });

  it("strips a markdown fence when one shows up anyway", async () => {
    const fenced = "```json\n" + JSON.stringify({ name: "f", tags: [] }) + "\n```";
    expect(await run(respond(candidate([fenced])))).toEqual({ name: "f", tags: [] });
  });
});

describe("failing usefully", () => {
  it("calls a 429 a quota problem, not an outage", async () => {
    // The caller offers a different remedy for each — "try later" versus
    // "set the other provider's key".
    await expect(run(respond({ error: { message: "rate limited" } }, 429))).rejects.toMatchObject(
      { reason: "quota" },
    );
  });

  it("reports a truncated answer as truncated", async () => {
    await expect(
      run(respond(candidate(['{"name":"a"'], "MAX_TOKENS"))),
    ).rejects.toMatchObject({ reason: "truncated" });
  });

  it("reports a safety stop as a refusal", async () => {
    await expect(run(respond(candidate([""], "SAFETY")))).rejects.toMatchObject({
      reason: "refused",
    });
  });

  it("reports a blocked prompt as a refusal", async () => {
    await expect(
      run(respond({ promptFeedback: { blockReason: "SAFETY" } })),
    ).rejects.toMatchObject({ reason: "refused" });
  });

  it("rejects an answer that does not fit the schema", async () => {
    /*
     * `responseSchema` constrains the shape but not the semantics, and Gemini's
     * subset drops constraints it does not understand. Validating with the
     * caller's Zod schema is what stops the two providers disagreeing about
     * what a valid answer is.
     */
    await expect(
      run(respond(candidate([JSON.stringify({ name: 42, tags: "not an array" })]))),
    ).rejects.toMatchObject({ reason: "unparseable" });
  });

  it("rejects a non-JSON body without throwing a raw SyntaxError", async () => {
    const error = await run(respond(candidate(["I'm sorry, I can't."]))).catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.reason).toBe("unparseable");
  });

  it("treats an empty candidate list as unparseable rather than crashing", async () => {
    await expect(run(respond({ candidates: [] }))).rejects.toMatchObject({
      reason: "unparseable",
    });
  });
});

describe("the request", () => {
  it("sends the key as a header, never in the URL", async () => {
    const fetchImpl = respond(candidate([JSON.stringify({ name: "a", tags: [] })]));
    await run(fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // A key in a query string ends up in proxy logs and error messages.
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("asks for JSON against a schema, at temperature zero", async () => {
    const fetchImpl = respond(candidate([JSON.stringify({ name: "a", tags: [] })]));
    await run(fetchImpl);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.type).toBe("object");
    // Extraction, not writing: the same page must give the same ICP.
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.systemInstruction.parts[0].text).toBe("s");
  });

  it("falls back to the default when the model is blank", async () => {
    /*
     * The bug this pins: a default parameter only fires on `undefined`, so
     * `GEMINI_MODEL=` in a .env file sailed past it and built
     * `.../models/:generateContent` — a 404 that reads exactly like a wrong
     * model name and sends the reader hunting through Google's model list.
     */
    const fetchImpl = respond(candidate([JSON.stringify({ name: "a", tags: [] })]));
    vi.stubGlobal("fetch", fetchImpl);
    await new GeminiExtractor("k", "").extract({
      system: "s",
      user: "u",
      schema,
      schemaName: "t",
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("gemini-2.5-flash");
    expect(url).not.toContain("models/:");
  });

  it("uses the model it was given", async () => {
    const fetchImpl = respond(candidate([JSON.stringify({ name: "a", tags: [] })]));
    vi.stubGlobal("fetch", fetchImpl);
    await new GeminiExtractor("k", "gemini-2.5-pro").extract({
      system: "s",
      user: "u",
      schema,
      schemaName: "t",
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("gemini-2.5-pro");
  });
});
