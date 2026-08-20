import { describe, expect, it } from "vitest";
import { allExtractors, configuredExtractors, preferredExtractor } from "./registry";

/**
 * The point of the seam is that the product works with *either* key. So what
 * needs pinning is the selection: which one runs, in what order, and that
 * nothing silently runs when no key is set.
 */

describe("preference order", () => {
  it("runs nothing when neither key is set", () => {
    expect(preferredExtractor({})).toBeNull();
    expect(configuredExtractors({})).toEqual([]);
  });

  it("uses Gemini when it is the only key — the free-tier path", () => {
    expect(preferredExtractor({ GEMINI_API_KEY: "g" })?.key).toBe("gemini");
  });

  it("uses Claude when it is the only key", () => {
    expect(preferredExtractor({ ANTHROPIC_API_KEY: "a" })?.key).toBe("anthropic");
  });

  it("prefers Claude when both are set", () => {
    // Not a coin flip and not a setting: Claude is measurably better at this
    // extraction, and a user with both keys should get the better answer
    // without having to know that.
    const both = { ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" };
    expect(preferredExtractor(both)?.key).toBe("anthropic");
    expect(configuredExtractors(both).map((e) => e.key)).toEqual(["anthropic", "gemini"]);
  });

  it("lists unconfigured providers too, so a setup screen can name them", () => {
    expect(allExtractors({}).map((e) => e.key)).toEqual(["anthropic", "gemini"]);
    expect(allExtractors({}).every((e) => !e.isConfigured())).toBe(true);
  });

  it("treats a blank key as no key at all", () => {
    /*
     * dotenv parses `GEMINI_API_KEY=` as `""`, not undefined, and `.env.example`
     * ships every provider line blank. Without this, a fresh setup reports the
     * provider as configured and then fails at the call.
     */
    expect(preferredExtractor({ GEMINI_API_KEY: "" })).toBeNull();
    expect(preferredExtractor({ ANTHROPIC_API_KEY: "   " })).toBeNull();
  });

  it("labels each provider with the variable that turns it on", () => {
    for (const extractor of allExtractors({})) {
      expect(extractor.label).toMatch(/API_KEY/);
    }
  });
});
