import { findSignalsFor } from "@/lib/signals/repository";
import { optionalString } from "@/lib/supabase/row";
import { getSessionContext } from "@/lib/supabase/server";
import { demoDataset, isDemoMode } from "./demo";
import { contactRowFrom } from "./rows";
import { SCORE_BANDS } from "./score";
import type { ContactRow } from "./types";

export type ContactFilter = {
  /** Matches name, title, company or email. */
  query?: string;
  agentId?: string;
  listId?: string;
  minScore?: number;
  page?: number;
  perPage?: number;
};

export type ContactPage = {
  rows: ContactRow[];
  total: number;
  page: number;
  perPage: number;
};

/**
 * The joined shape every lead query selects.
 *
 * One literal, not a concatenation: supabase-js reads this at the type level
 * and `"a" + "b"` widens to `string`, which turns every row into
 * `GenericStringError`.
 */
export const LEAD_COLUMNS =
  "id, company_id, score, score_breakdown, source_label, source_query, fit_feedback, agent_id, created_at, people(full_name, title), companies(name, domain, country, county, caen, phone), emails(address, status, confidence, is_role_address), lists(id, name)";

/**
 * Filtering runs here rather than in the page so that the same predicate serves
 * the fixtures today and becomes a `where` clause later. A page component that
 * filters its own array would have to be rewritten when the data moves.
 */
export function matchesFilter(row: ContactRow, filter: ContactFilter): boolean {
  if (filter.agentId && row.agentId !== filter.agentId) return false;
  if (filter.listId && row.list?.id !== filter.listId) return false;
  if (filter.minScore !== undefined && row.score < filter.minScore) return false;

  const query = filter.query?.trim().toLowerCase();
  if (!query) return true;

  return [
    row.fullName,
    row.title,
    row.companyName,
    row.companyDomain,
    row.email?.address,
    row.county,
  ].some((field) => field?.toLowerCase().includes(query));
}

export async function listContacts(
  filter: ContactFilter = {},
): Promise<ContactPage> {
  const page = Math.max(1, filter.page ?? 1);
  const perPage = Math.min(200, Math.max(1, filter.perPage ?? 100));

  if (isDemoMode()) {
    const matched = demoDataset().contacts.filter((row) =>
      matchesFilter(row, filter),
    );
    return {
      rows: matched.slice((page - 1) * perPage, page * perPage),
      total: matched.length,
      page,
      perPage,
    };
  }

  const session = await getSessionContext();
  if (!session?.orgId) return { rows: [], total: 0, page, perPage };

  let query = session.supabase
    .from("leads")
    .select(LEAD_COLUMNS, { count: "exact" })
    .eq("org_id", session.orgId)
    .order("score", { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);

  // Pushed into the query rather than filtered after fetching: the point of
  // paginating is not to read the rows we are about to discard.
  if (filter.agentId) query = query.eq("agent_id", filter.agentId);
  if (filter.minScore !== undefined) query = query.gte("score", filter.minScore);

  const { data, error, count } = await query;
  if (error) {
    console.error("Listing contacts failed:", error.message, error.details ?? "");
    return { rows: [], total: 0, page, perPage };
  }

  /*
   * Signals for this page only, in one batched read.
   *
   * `signals` is shared reference data readable by any authenticated user, so
   * the caller's own client is enough — no service role, and RLS still decides
   * which *leads* were returned above.
   *
   * Not an embedded PostgREST join: `signals` has no foreign key from `leads`,
   * only from `companies`, and a nested select would fetch every signal a
   * company ever had for every row. `findSignalsFor` chunks the ids and pages
   * past the silent 1,000-row cap, which is the part that bites at 100 rows a
   * page with several signals each.
   */
  const raw = (data ?? []) as Record<string, unknown>[];
  const signalsByCompany = await findSignalsFor(
    session.supabase,
    raw
      .map((row) => optionalString(row.company_id))
      .filter((id): id is string => Boolean(id)),
  );

  const rows = raw.map((row) =>
    contactRowFrom(row, signalsByCompany.get(optionalString(row.company_id) ?? "") ?? []),
  );

  // Text search and list membership still run in memory: the first needs a
  // join across three tables that PostgREST cannot express as one `or`, and
  // the second is a join table. Both are correct, just not yet pushed down.
  const filtered =
    filter.query || filter.listId
      ? rows.filter((row) => matchesFilter(row, filter))
      : rows;

  return {
    rows: filtered,
    total: filter.query || filter.listId ? filtered.length : (count ?? filtered.length),
    page,
    perPage,
  };
}

export async function hotContacts(limit = 5): Promise<ContactRow[]> {
  const { rows } = await listContacts({ minScore: SCORE_BANDS.hot, perPage: limit });
  return rows;
}

/**
 * The best leads, hot or not.
 *
 * The dashboard's "Latest Hot Leads" card falls back to this when nothing has
 * cleared the hot band yet — an empty card would read as "the agent found
 * nothing", when in fact it found leads that are merely not hot.
 */
export async function topContacts(limit = 5): Promise<ContactRow[]> {
  const hot = await hotContacts(limit);
  if (hot.length > 0) return hot;
  const { rows } = await listContacts({ perPage: limit });
  return rows;
}
