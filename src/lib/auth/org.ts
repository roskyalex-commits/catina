/**
 * Org bootstrap.
 *
 * A newly authenticated user has no org, and cannot make one: RLS on `orgs`
 * grants `authenticated` select and update but never insert (see
 * drizzle/policies.sql). That is deliberate — org creation decides tenancy, so
 * it belongs to the service role, not to whoever holds a session.
 *
 * Chosen over Supabase's usual `handle_new_user` trigger. A trigger that throws
 * makes signup fail inside GoTrue with no surfaced error and no stack; a route
 * returns a status code and shows up in the network tab.
 */

const MAX_SLUG_ATTEMPTS = 25;

/**
 * Derive a URL-safe slug from an email local part.
 *
 * Romanian names carry diacritics, so decompose and strip the combining marks
 * rather than dropping the letters: "ștefan" must become "stefan", not "tefan".
 */
export function slugFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const slug = local
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  // "+", "." and "_" are legal local parts that can strip to nothing.
  return slug || "workspace";
}

/** Human-facing workspace name, used until the user renames it. */
export function orgNameFromEmail(email: string): string {
  const domain = email.split("@")[1] ?? "";
  const free = new Set([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.ro",
    "outlook.com",
    "hotmail.com",
    "icloud.com",
    "proton.me",
    "protonmail.com",
  ]);

  // A company domain is a better workspace name than the person's first name;
  // a free mailbox tells us nothing, so fall back to the local part.
  if (domain && !free.has(domain.toLowerCase())) {
    const label = domain.split(".")[0] ?? domain;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  const local = (email.split("@")[0] ?? "you").replace(/[._+-]+/g, " ");
  return `${local.charAt(0).toUpperCase()}${local.slice(1)}'s workspace`;
}

/**
 * Candidate slugs in preference order: the bare slug, then numbered variants.
 * Two people at different companies can both be `alex@`, and `slug` is unique.
 */
export function slugCandidates(base: string): string[] {
  return [
    base,
    ...Array.from({ length: MAX_SLUG_ATTEMPTS - 1 }, (_, i) => `${base}-${i + 2}`),
  ];
}
