import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toGeminiSchema } from "./gemini-schema";

/**
 * Gemini rejects an unrecognised schema keyword with a 400 rather than ignoring
 * it, so "does this schema contain anything Gemini has not heard of" is the
 * whole test. A single leftover `additionalProperties` fails every analysis.
 */

/** Walk the converted schema and collect every key at every depth. */
function keysIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const entry of node) keysIn(entry, found);
    return found;
  }
  if (typeof node !== "object" || node === null) return found;

  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    // Property *names* are data, not keywords — descend into their schemas
    // without recording the names themselves.
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) keysIn(child, found);
      continue;
    }
    keysIn(value, found);
  }
  return found;
}

const ALLOWED = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "propertyOrdering",
  "minItems",
  "maxItems",
  "anyOf",
]);

describe("toGeminiSchema", () => {
  it("emits nothing outside the subset Gemini accepts", () => {
    const schema = z.object({
      name: z.string().describe("A name"),
      count: z.number().int(),
      tags: z.array(z.string()),
      level: z.enum(["a", "b"]),
      nested: z.object({ inner: z.array(z.enum(["x", "y"])) }),
    });

    const unexpected = [...keysIn(toGeminiSchema(schema))].filter(
      (key) => !ALLOWED.has(key),
    );
    expect(unexpected).toEqual([]);
  });

  it("keeps descriptions, which carry the field guidance", () => {
    // "3-10 job titles, most likely buyer first" is doing real work. Stripping
    // descriptions would leave valid JSON and much worse extraction.
    const schema = z.object({
      titles: z.array(z.string()).describe("3-10 job titles, buyer first."),
    });
    const converted = toGeminiSchema(schema) as {
      properties: { titles: { description?: string } };
    };
    expect(converted.properties.titles.description).toBe("3-10 job titles, buyer first.");
  });

  it("names the field order, which Gemini does not infer", () => {
    const schema = z.object({ first: z.string(), second: z.string() });
    const converted = toGeminiSchema(schema) as { propertyOrdering: string[] };
    expect(converted.propertyOrdering).toEqual(["first", "second"]);
  });

  it("carries enums through so the model cannot invent a value", () => {
    const schema = z.object({ level: z.enum(["founder", "c_level"]) });
    const converted = toGeminiSchema(schema) as {
      properties: { level: { enum: string[] } };
    };
    expect(converted.properties.level.enum).toEqual(["founder", "c_level"]);
  });

  it("inlines references instead of leaving a $ref Gemini cannot resolve", () => {
    // A schema reused in two places is exactly what makes Zod emit `$defs`.
    const shared = z.object({ id: z.string() });
    const schema = z.object({ a: shared, b: shared });

    const keys = keysIn(toGeminiSchema(schema));
    expect(keys.has("$ref")).toBe(false);
    expect(keys.has("$defs")).toBe(false);
  });

  it("keeps required, so a field cannot come back missing", () => {
    const schema = z.object({ a: z.string(), b: z.string() });
    const converted = toGeminiSchema(schema) as { required: string[] };
    expect(converted.required.sort()).toEqual(["a", "b"]);
  });

  it("survives the real extraction schema", () => {
    // The schema that actually ships — arrays of enums, nested descriptions,
    // fifteen fields. If this one converts clean, the analysis can run.
    const schema = z.object({
      valueProp: z.string().describe("One sentence."),
      targetSeniorities: z.array(z.enum(["founder", "c_level", "vp"])),
      industryKeys: z.array(z.enum(["software", "retail"])).describe("2-5 industries."),
      employeeMin: z.number().int().describe("0 if unknown."),
      confidence: z.number().describe("0-1."),
      assumptions: z.array(z.string()),
    });

    const converted = toGeminiSchema(schema);
    const unexpected = [...keysIn(converted)].filter((key) => !ALLOWED.has(key));
    expect(unexpected).toEqual([]);
    expect((converted as { type: string }).type).toBe("object");
  });
});
