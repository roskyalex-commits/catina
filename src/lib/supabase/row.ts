/**
 * Narrowing helpers for PostgREST results.
 *
 * `Database` in ./types.ts is a permissive placeholder until `npm run db:types`
 * can run against a real project, so every selected column arrives as
 * `unknown`. Casting would paper over that; these check at runtime instead.
 *
 * They stay correct (just redundant) once generated types land, so nothing has
 * to be unpicked later.
 */

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Expected "${field}" to be a non-empty string, received ${typeof value}. ` +
        `If the schema changed, regenerate types with: npm run db:types`,
    );
  }
  return value;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // numeric columns come back as strings over PostgREST to preserve precision.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function optionalDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
