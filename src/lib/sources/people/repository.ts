import type { SupabaseClient } from "@supabase/supabase-js";
import { slugifyName } from "@/lib/enrichment/patterns";
import { resolvePersonName } from "@/lib/enrichment/romanian-names";
import { optionalString, requireString } from "@/lib/supabase/row";
import { classifySeniority } from "./seniority";
import type { FoundPerson } from "./types";

/**
 * The only place that writes a `FoundPerson` into `people`.
 *
 * Four provider adapters have existed since Phase 2b and **none of their output
 * has ever been persisted**. `EmailWaterfall` calls `findPeople`, matches one
 * person to pull an address out of, and drops the rest on the floor — job
 * title, department, LinkedIn URL and all. So a paid people vendor would today
 * buy us an email and throw away the one field the ICP most needs.
 *
 * That is the same shape as the constant zeros this project has already found:
 * a complete producer with no consumer. This is the consumer.
 *
 * ## Why merging is the hard part
 *
 * We are not writing into an empty table. `people` holds 29,551 ONRC
 * administrators, and a vendor will return many of the same humans with better
 * titles. Inserting would produce two rows for one person at one company, which
 * is worse than not importing at all: sourcing picks one contact per company,
 * so a duplicate means a coin flip between the good record and the poor one.
 *
 * `people_linkedin_idx` is UNIQUE on `linkedin_url`, which dedupes vendor rows
 * against each other and says nothing at all about the ONRC rows, none of which
 * have a URL. So identity here is `(company_id, slugified first + last)` — the
 * same folding `patterns.ts` uses to build an address, so two spellings of one
 * name collapse the way an email address would.
 */

/** One literal: supabase-js reads this at the type level and `"a" + "b"` widens. */
export const PEOPLE_COLUMNS =
  "id, company_id, full_name, first_name, last_name, title, seniority, department, linkedin_url, location, source";

/**
 * Titles that carry no information about what someone actually does.
 *
 * ONRC publishes who is *legally* responsible, not who runs marketing, so every
 * one of the 29,551 imported people is an `administrator` or a near-synonym.
 * That is a real fact and worth keeping when it is all we have — but the moment
 * a vendor says "Director de Marketing", the registry word must give way.
 *
 * Compared after folding, because the register writes these with and without
 * diacritics interchangeably.
 */
const GENERIC_TITLES = new Set([
  "administrator",
  "administrator si reprezentant",
  "reprezentant legal",
  "reprezentant al persoanei juridice",
  "asociat",
  "asociat unic",
  "persoana de contact",
  "contact",
]);

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Does this title actually say what the person does? */
export function isGenericTitle(title: string | null | undefined): boolean {
  if (!title?.trim()) return true;
  return GENERIC_TITLES.has(fold(title));
}

/**
 * The identity two records have to share to be the same person.
 *
 * First + last, folded. Deliberately not the full display name: ONRC writes
 * `Podar Simona Mihaela` and a vendor writes `Simona Podar`, and only the
 * resolved halves make those the same human.
 */
export function personKey(
  companyId: string,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const first = slugifyName(firstName ?? undefined);
  const last = slugifyName(lastName ?? undefined);
  if (!first || !last) return null;
  return `${companyId}:${first}.${last}`;
}

export type ExistingPerson = {
  id: string;
  companyId: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  linkedinUrl: string | null;
  location: string | null;
  source: string;
};

export function personFrom(row: Record<string, unknown>): ExistingPerson {
  return {
    id: requireString(row.id, "id"),
    companyId: requireString(row.company_id, "company_id"),
    fullName: optionalString(row.full_name) ?? "",
    firstName: optionalString(row.first_name) ?? null,
    lastName: optionalString(row.last_name) ?? null,
    title: optionalString(row.title) ?? null,
    seniority: optionalString(row.seniority) ?? null,
    department: optionalString(row.department) ?? null,
    linkedinUrl: optionalString(row.linkedin_url) ?? null,
    location: optionalString(row.location) ?? null,
    source: optionalString(row.source) ?? "",
  };
}

/** A row ready for the table, plus the id when it is an update. */
export type PersonWrite = {
  id?: string;
  company_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  linkedin_url: string | null;
  location: string | null;
  source: string;
};

/**
 * Decide what to write for one incoming person, given who we already hold.
 *
 * Pure, and separated from the IO so the merge rules can be tested without a
 * database — they are the part that will quietly corrupt 29,551 rows if wrong.
 *
 * The rule throughout is **enrich, never downgrade**. A vendor knows the job
 * title; the register knows the legal name and that this person is an officer
 * of the company. Neither is strictly better, so each field takes the more
 * informative value rather than the more recent one.
 */
export function mergePerson(
  companyId: string,
  incoming: FoundPerson,
  existing: ExistingPerson | undefined,
  source: string,
): PersonWrite | null {
  const resolved = resolvePersonName({
    fullName: incoming.fullName,
    firstName: incoming.firstName,
    lastName: incoming.lastName,
    source,
  });

  const firstName = resolved.firstName ?? existing?.firstName ?? null;
  const lastName = resolved.lastName ?? existing?.lastName ?? null;

  // Without both halves there is no identity to merge on and no address to
  // build later, so the row would be a name we can do nothing with.
  if (!existing && (!firstName || !lastName)) return null;

  /*
   * Title: a real one wins over a generic one, in either direction. A vendor
   * saying `administrator` must not overwrite a `Director de Marketing` we
   * already had, and the reverse is the whole reason to import.
   */
  const incomingTitle = incoming.title?.trim() || null;
  const title =
    incomingTitle && !isGenericTitle(incomingTitle)
      ? incomingTitle
      : existing?.title && !isGenericTitle(existing.title)
        ? existing.title
        : (incomingTitle ?? existing?.title ?? null);

  return {
    // `existing.id` is empty for a row queued in this same batch and not yet
    // written, which must stay on the insert path.
    ...(existing?.id ? { id: existing.id } : {}),
    company_id: companyId,
    /*
     * Keep the register's display name once we have one. It is the legal
     * spelling, with diacritics, and it is what appears in the UI — a vendor's
     * `SIMONA PODAR` is not an improvement on `Podar Simona Mihaela`.
     */
    full_name: existing?.fullName || incoming.fullName.trim(),
    first_name: firstName,
    last_name: lastName,
    title,
    // Recomputed from whichever title won, so the two can never disagree.
    seniority: classifySeniority(title ?? undefined) ?? existing?.seniority ?? null,
    department: incoming.department?.trim() || existing?.department || null,
    linkedin_url: incoming.linkedinUrl?.trim() || existing?.linkedinUrl || null,
    location: incoming.location?.trim() || existing?.location || null,
    // The register stays the source of record for a person it gave us; a vendor
    // enriched the row, it did not originate it.
    source: existing?.source || source,
  };
}

/**
 * A queued insert read back as an existing record, for in-batch merging.
 *
 * Written out rather than cast: the two types name the same fields in different
 * cases, and a cast that compiles today would silently drop a field the day
 * either shape gains one.
 */
function asExisting(row: PersonWrite): ExistingPerson {
  return {
    // No id yet by construction — this row has not been written. `mergePerson`
    // only reads it to decide insert-versus-update, and an empty string keeps
    // it on the insert path.
    id: "",
    companyId: row.company_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    title: row.title,
    seniority: row.seniority,
    department: row.department,
    linkedinUrl: row.linkedin_url,
    location: row.location,
    source: row.source,
  };
}

export type UpsertPeopleResult = {
  inserted: number;
  updated: number;
  skipped: number;
  error?: string;
};

/**
 * Write a provider's people for one company, merging onto what we hold.
 *
 * Reads the company's existing people first — one query, not one per person —
 * because the merge needs them and because a lookup each is how a bulk import
 * acquires an N+1 against a hosted database.
 */
export async function upsertPeople(
  admin: SupabaseClient,
  companyId: string,
  people: readonly FoundPerson[],
  source: string,
): Promise<UpsertPeopleResult> {
  const result: UpsertPeopleResult = { inserted: 0, updated: 0, skipped: 0 };
  if (people.length === 0) return result;

  const { data, error } = await admin
    .from("people")
    .select(PEOPLE_COLUMNS)
    .eq("company_id", companyId);

  if (error) {
    return { ...result, error: `Reading people failed: ${error.message}` };
  }

  const existing = (data ?? []).map((row) => personFrom(row as Record<string, unknown>));
  const byKey = new Map<string, ExistingPerson>();
  for (const person of existing) {
    const key = personKey(companyId, person.firstName, person.lastName);
    if (key) byKey.set(key, person);
  }

  /*
   * Pending inserts are keyed too, and separately from `byKey`.
   *
   * A provider returning the same person twice in one payload — common when
   * someone holds two roles — would otherwise be inserted twice in a single
   * batch, and the unique index cannot catch it because neither row has a
   * LinkedIn URL. Keeping them in their own map means a repeat merges into the
   * pending row instead of being mistaken for an existing one, which is what a
   * shared map would do: it would hand `mergePerson` a record with no id and
   * produce an update against an empty string.
   */
  const pendingInserts = new Map<string, PersonWrite>();
  const updates: PersonWrite[] = [];

  for (const incoming of people) {
    const resolved = resolvePersonName({
      fullName: incoming.fullName,
      firstName: incoming.firstName,
      lastName: incoming.lastName,
      source,
    });
    const key = personKey(companyId, resolved.firstName, resolved.lastName);
    const match = key ? byKey.get(key) : undefined;

    const write = mergePerson(companyId, incoming, match, source);
    if (!write) {
      result.skipped += 1;
      continue;
    }

    if (write.id) {
      updates.push(write);
      continue;
    }

    if (!key) {
      result.skipped += 1;
      continue;
    }

    const pending = pendingInserts.get(key);
    // Second sighting in the same payload: merge onto the row already queued,
    // so the better title wins exactly as it would against a stored row.
    pendingInserts.set(
      key,
      pending ? (mergePerson(companyId, incoming, asExisting(pending), source) ?? pending) : write,
    );
  }

  const inserts = [...pendingInserts.values()];

  if (inserts.length > 0) {
    const { error: insertError } = await admin.from("people").insert(inserts);
    if (insertError) {
      return { ...result, error: `Inserting people failed: ${insertError.message}` };
    }
    result.inserted = inserts.length;
  }

  for (const update of updates) {
    const { id, ...fields } = update;
    const { error: updateError } = await admin
      .from("people")
      .update(fields)
      .eq("id", id as string);
    if (updateError) {
      return { ...result, error: `Updating person ${id} failed: ${updateError.message}` };
    }
    result.updated += 1;
  }

  return result;
}
