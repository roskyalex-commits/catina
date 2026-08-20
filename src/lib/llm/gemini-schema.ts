import { z } from "zod";

/**
 * Zod → the schema subset Gemini's structured output accepts.
 *
 * Gemini takes an OpenAPI 3.0 *subset*, not JSON Schema, and it is strict about
 * it: an unrecognised keyword is a 400, not something it ignores. Three things
 * that `z.toJSONSchema` emits and Gemini rejects:
 *
 *   `$ref` / `$defs`      — every reference has to be inlined
 *   `additionalProperties`— rejected outright
 *   `$schema`, `default`  — rejected outright
 *
 * `description` is deliberately kept. It is the only channel the field guidance
 * travels through — "3-10 job titles, most likely buyer first" is doing real
 * work, and a converter that stripped descriptions would silently make the
 * extraction much worse while still returning valid JSON.
 *
 * `propertyOrdering` is added because Gemini's own guidance is that output
 * quality depends on field order, and JSON object key order is not something
 * the API infers from `properties` on its own.
 */

/** Keys Gemini understands. Anything else is dropped rather than sent. */
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

type JsonSchema = Record<string, unknown>;

export function toGeminiSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
    // Inline everything. Gemini has no `$ref` resolver, and a schema that
    // references `$defs` fails as a 400 rather than degrading.
    reused: "inline",
  }) as JsonSchema;

  return sanitise(json, json);
}

function sanitise(node: unknown, root: JsonSchema): JsonSchema {
  if (typeof node !== "object" || node === null) return {};
  const source = node as JsonSchema;

  // A stray `$ref` can survive `reused: "inline"` for a schema that references
  // itself. Resolve what we can; anything unresolvable becomes a bare object,
  // which Gemini accepts, rather than a 400.
  if (typeof source.$ref === "string") {
    const resolved = resolveRef(source.$ref, root);
    return resolved ? sanitise(resolved, root) : { type: "object" };
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(source)) {
    if (!ALLOWED.has(key)) continue;

    if (key === "properties" && typeof value === "object" && value !== null) {
      const properties: JsonSchema = {};
      for (const [name, child] of Object.entries(value as JsonSchema)) {
        properties[name] = sanitise(child, root);
      }
      out.properties = properties;
      // Gemini's docs are explicit that field order affects output quality, and
      // it will not infer one from `properties`.
      out.propertyOrdering = Object.keys(properties);
      continue;
    }

    if (key === "items") {
      out.items = sanitise(value, root);
      continue;
    }

    if (key === "anyOf" && Array.isArray(value)) {
      out.anyOf = value.map((entry) => sanitise(entry, root));
      continue;
    }

    out[key] = value;
  }

  return out;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as JsonSchema)[decodeURIComponent(segment)];
  }
  return typeof node === "object" && node !== null ? (node as JsonSchema) : null;
}
